/**
 * PacketCache - Intelligent caching layer for consistent topology
 * 
 * Strategy:
 * 1. Bootstrap: Quick 24h fetch for immediate usability
 * 2. Deep Load: Background fetch of entire DB for complete topology
 * 3. Poll: Incremental updates for new packets
 * 4. Persist: localStorage survives page refresh
 */

import type { Packet } from '@/types/api';

const STORAGE_KEY = 'pymc-packet-cache';
const META_KEY = 'pymc-packet-cache-meta';
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour - clear cache if away longer
const BOOTSTRAP_HOURS = 24;
const DEEP_LOAD_BATCH_SIZE = 1000;
const DEEP_LOAD_DELAY_MS = 100; // Small delay between batches to not overwhelm Pi

export interface PacketCacheMeta {
  oldestTimestamp: number;
  newestTimestamp: number;
  lastUpdated: number;
  deepLoadComplete: boolean;
  packetCount: number;
}

export interface PacketCacheState {
  isBootstrapping: boolean;
  isDeepLoading: boolean;
  packetCount: number;
  deepLoadComplete: boolean;
}

type StateListener = (state: PacketCacheState) => void;

class PacketCache {
  private packets: Map<string, Packet> = new Map(); // Keyed by packet_hash for dedup
  private meta: PacketCacheMeta = {
    oldestTimestamp: 0,
    newestTimestamp: 0,
    lastUpdated: 0,
    deepLoadComplete: false,
    packetCount: 0,
  };
  private isBootstrapping = false;
  private isDeepLoading = false;
  private listeners: Set<StateListener> = new Set();
  private deepLoadAborted = false;

  constructor() {
    this.loadFromStorage();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to cache state changes
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    // Immediately notify with current state
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current cache state
   */
  getState(): PacketCacheState {
    return {
      isBootstrapping: this.isBootstrapping,
      isDeepLoading: this.isDeepLoading,
      packetCount: this.packets.size,
      deepLoadComplete: this.meta.deepLoadComplete,
    };
  }

  /**
   * Get all cached packets (sorted by timestamp ascending)
   */
  getPackets(): Packet[] {
    return Array.from(this.packets.values())
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  /**
   * Check if cache needs bootstrap (empty or stale)
   */
  needsBootstrap(): boolean {
    if (this.packets.size === 0) return true;
    const age = Date.now() - this.meta.lastUpdated;
    return age > STALE_THRESHOLD_MS;
  }

  /**
   * Check if deep load should run
   */
  needsDeepLoad(): boolean {
    return !this.meta.deepLoadComplete;
  }

  /**
   * Bootstrap: Quick 24h fetch for immediate usability
   */
  async bootstrap(): Promise<Packet[]> {
    // If cache is fresh, just return existing data
    if (!this.needsBootstrap()) {
      return this.getPackets();
    }

    // If stale (away > 1hr), clear everything
    if (this.packets.size > 0) {
      this.clear();
    }

    this.isBootstrapping = true;
    this.notifyListeners();

    try {
      const startTimestamp = Math.floor(Date.now() / 1000) - (BOOTSTRAP_HOURS * 3600);
      const response = await this.fetchFilteredPackets(startTimestamp, undefined, 10000);
      
      if (response.success && response.data) {
        this.mergePackets(response.data);
        this.saveToStorage();
      }
    } catch (error) {
      console.error('[PacketCache] Bootstrap failed:', error);
    } finally {
      this.isBootstrapping = false;
      this.notifyListeners();
    }

    return this.getPackets();
  }

  /**
   * Deep Load: Fetch entire database in background
   * Paginates backwards from oldest cached timestamp
   */
  async deepLoad(): Promise<void> {
    if (this.meta.deepLoadComplete || this.isDeepLoading) {
      return;
    }

    this.isDeepLoading = true;
    this.deepLoadAborted = false;
    this.notifyListeners();

    try {
      let fetchedCount = 0;
      let iterations = 0;
      const maxIterations = 100; // Safety limit

      while (!this.deepLoadAborted && iterations < maxIterations) {
        iterations++;
        
        // Fetch packets older than our oldest
        const endTimestamp = this.meta.oldestTimestamp > 0 
          ? this.meta.oldestTimestamp - 0.001 // Slightly before oldest to avoid duplicates
          : undefined;
        
        const response = await this.fetchFilteredPackets(undefined, endTimestamp, DEEP_LOAD_BATCH_SIZE);
        
        if (!response.success || !response.data || response.data.length === 0) {
          // No more packets - deep load complete
          this.meta.deepLoadComplete = true;
          this.saveToStorage();
          break;
        }

        fetchedCount += response.data.length;
        this.mergePackets(response.data);
        this.saveToStorage();
        this.notifyListeners();

        // If we got fewer than batch size, we've reached the end
        if (response.data.length < DEEP_LOAD_BATCH_SIZE) {
          this.meta.deepLoadComplete = true;
          this.saveToStorage();
          break;
        }

        // Small delay to not overwhelm the Pi
        await this.delay(DEEP_LOAD_DELAY_MS);
      }

      console.log(`[PacketCache] Deep load complete: ${fetchedCount} additional packets fetched`);
    } catch (error) {
      console.error('[PacketCache] Deep load failed:', error);
    } finally {
      this.isDeepLoading = false;
      this.notifyListeners();
    }
  }

  /**
   * Poll: Incremental fetch for new packets
   */
  async poll(): Promise<Packet[]> {
    try {
      // Fetch recent packets (relies on existing SWR cache in api.ts)
      const response = await this.fetchRecentPackets(200);
      
      if (response.success && response.data) {
        const beforeCount = this.packets.size;
        this.mergePackets(response.data);
        
        // Only save if we got new packets
        if (this.packets.size > beforeCount) {
          this.saveToStorage();
          this.notifyListeners();
        }
      }
    } catch (error) {
      console.error('[PacketCache] Poll failed:', error);
    }

    return this.getPackets();
  }

  /**
   * Clear cache and reset state
   */
  clear(): void {
    this.packets.clear();
    this.meta = {
      oldestTimestamp: 0,
      newestTimestamp: 0,
      lastUpdated: 0,
      deepLoadComplete: false,
      packetCount: 0,
    };
    this.deepLoadAborted = true;
    this.clearStorage();
    this.notifyListeners();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private mergePackets(newPackets: Packet[]): void {
    for (const packet of newPackets) {
      const hash = packet.packet_hash;
      if (hash && !this.packets.has(hash)) {
        this.packets.set(hash, packet);
        
        const ts = packet.timestamp ?? 0;
        if (this.meta.oldestTimestamp === 0 || ts < this.meta.oldestTimestamp) {
          this.meta.oldestTimestamp = ts;
        }
        if (ts > this.meta.newestTimestamp) {
          this.meta.newestTimestamp = ts;
        }
      }
    }
    
    this.meta.lastUpdated = Date.now();
    this.meta.packetCount = this.packets.size;
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Storage
  // ═══════════════════════════════════════════════════════════════════════════

  private loadFromStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const metaStr = localStorage.getItem(META_KEY);
      if (metaStr) {
        this.meta = JSON.parse(metaStr);
      }

      const packetsStr = localStorage.getItem(STORAGE_KEY);
      if (packetsStr) {
        const packets: Packet[] = JSON.parse(packetsStr);
        for (const packet of packets) {
          if (packet.packet_hash) {
            this.packets.set(packet.packet_hash, packet);
          }
        }
      }

      // Check if cache is stale (user was away > 1hr)
      if (this.meta.lastUpdated > 0) {
        const age = Date.now() - this.meta.lastUpdated;
        if (age > STALE_THRESHOLD_MS) {
          console.log('[PacketCache] Cache stale (away > 1hr), will re-bootstrap');
          this.clear();
        }
      }
    } catch (error) {
      console.error('[PacketCache] Failed to load from storage:', error);
      this.clear();
    }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      localStorage.setItem(META_KEY, JSON.stringify(this.meta));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(this.packets.values())));
    } catch (error) {
      // localStorage might be full - try to continue without persistence
      console.warn('[PacketCache] Failed to save to storage:', error);
    }
  }

  private clearStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(META_KEY);
    } catch (error) {
      console.warn('[PacketCache] Failed to clear storage:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API Calls (direct fetch to avoid circular dependency with api.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  private async fetchFilteredPackets(
    startTimestamp?: number,
    endTimestamp?: number,
    limit = 1000
  ): Promise<{ success: boolean; data?: Packet[] }> {
    const API_BASE = import.meta.env.VITE_API_URL || '';
    const params = new URLSearchParams();
    if (startTimestamp !== undefined) params.set('start_timestamp', startTimestamp.toString());
    if (endTimestamp !== undefined) params.set('end_timestamp', endTimestamp.toString());
    params.set('limit', limit.toString());

    const url = `${API_BASE}/api/filtered_packets?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return response.json();
  }

  private async fetchRecentPackets(limit = 100): Promise<{ success: boolean; data?: Packet[] }> {
    const API_BASE = import.meta.env.VITE_API_URL || '';
    const url = `${API_BASE}/api/recent_packets?limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return response.json();
  }
}

// Singleton instance
export const packetCache = new PacketCache();
