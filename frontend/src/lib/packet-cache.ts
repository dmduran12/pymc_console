/**
 * PacketCache - Caching layer for packet data with localStorage persistence
 * 
 * Strategy:
 * 1. Load from localStorage on init (instant)
 * 2. Quick fetch of 1,000 packets for fast startup
 * 3. Background fetch of 20,000 packets for rich topology (~7 days)
 * 4. Merge and deduplicate by packet_hash
 * 5. Persist to localStorage
 * 
 * Note: Backend only supports /api/recent_packets with a limit.
 */

import type { Packet } from '@/types/api';

const STORAGE_KEY = 'pymc-packet-cache';
const META_KEY = 'pymc-packet-cache-meta';
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour - clear cache if away longer
const QUICK_FETCH_LIMIT = 1000;  // Fast initial load (instant charts)
const BACKGROUND_FETCH_LIMIT = 30000;  // Background load for app-wide data (~10 days)
const DEEP_FETCH_LIMIT = 50000;  // Deep analysis for topology (user-triggered)
const POLL_LIMIT = 500;          // Incremental polling

export interface PacketCacheMeta {
  oldestTimestamp: number;
  newestTimestamp: number;
  lastUpdated: number;
  packetCount: number;
  backgroundLoadComplete: boolean;  // 30k background load done
  deepLoadComplete: boolean;        // 50k deep analysis done
}

export interface PacketCacheState {
  isLoading: boolean;
  isBackgroundLoading: boolean;  // 30k background load in progress
  isDeepLoading: boolean;        // 50k deep analysis in progress
  backgroundLoadComplete: boolean;  // 30k load finished (map can render)
  packetCount: number;
  /** Status message for UI feedback */
  statusMessage: string;
}

type StateListener = (state: PacketCacheState) => void;

class PacketCache {
  private packets: Map<string, Packet> = new Map(); // Keyed by packet_hash for dedup
  private meta: PacketCacheMeta = {
    oldestTimestamp: 0,
    newestTimestamp: 0,
    lastUpdated: 0,
    packetCount: 0,
    backgroundLoadComplete: false,
    deepLoadComplete: false,
  };
  private isLoading = false;
  private isBackgroundLoading = false;
  private isDeepLoading = false;
  private listeners: Set<StateListener> = new Set();

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

  private statusMessage = '';

  /**
   * Get current cache state
   */
  getState(): PacketCacheState {
    return {
      isLoading: this.isLoading,
      isBackgroundLoading: this.isBackgroundLoading,
      isDeepLoading: this.isDeepLoading,
      backgroundLoadComplete: this.meta.backgroundLoadComplete,
      packetCount: this.packets.size,
      statusMessage: this.statusMessage,
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
   * Check if cache is stale (away > 1hr)
   */
  isStale(): boolean {
    if (this.packets.size === 0) return true;
    const age = Date.now() - this.meta.lastUpdated;
    return age > STALE_THRESHOLD_MS;
  }

  /**
   * Quick load: Fast 1K packet fetch for immediate usability
   * Triggers 30K background load automatically for map/topology data
   */
  async quickLoad(): Promise<Packet[]> {
    // If stale (away > 1hr), clear and refetch
    if (this.isStale() && this.packets.size > 0) {
      console.log('[PacketCache] Cache stale, clearing...');
      this.clear();
    }

    // Return cached data immediately if we have any
    if (this.packets.size > 0) {
      // Trigger background load if not done (30k for map)
      if (!this.meta.backgroundLoadComplete) {
        this.backgroundLoad();
      }
      return this.getPackets();
    }

    // No cached data - do quick initial load (1k)
    this.isLoading = true;
    this.statusMessage = 'Fetching recent packets...';
    this.notifyListeners();

    try {
      const response = await this.fetchRecentPackets(QUICK_FETCH_LIMIT);
      
      if (response.success && response.data) {
        this.statusMessage = `Processing ${response.data.length} packets...`;
        this.notifyListeners();
        this.mergePackets(response.data);
        this.saveToStorage();
        console.log(`[PacketCache] Quick load: ${response.data.length} packets`);
      }
    } catch (error) {
      console.error('[PacketCache] Quick load failed:', error);
      this.statusMessage = 'Load failed';
    } finally {
      this.isLoading = false;
      this.statusMessage = '';
      this.notifyListeners();
    }

    // Trigger background load (30k) for map/topology
    this.backgroundLoad();

    return this.getPackets();
  }

  /**
   * Background load: 30K packets for map and topology data.
   * Runs automatically after quick load, enables the contacts map.
   */
  async backgroundLoad(): Promise<void> {
    if (this.meta.backgroundLoadComplete || this.isBackgroundLoading) {
      return;
    }

    this.isBackgroundLoading = true;
    this.statusMessage = 'Loading database...';
    this.notifyListeners();

    try {
      // Update status periodically while fetching
      const statusInterval = setInterval(() => {
        if (this.isBackgroundLoading) {
          this.statusMessage = `Loading ${BACKGROUND_FETCH_LIMIT.toLocaleString()} packets...`;
          this.notifyListeners();
        }
      }, 500);

      const response = await this.fetchRecentPackets(BACKGROUND_FETCH_LIMIT);
      clearInterval(statusInterval);
      
      if (response.success && response.data) {
        this.statusMessage = `Processing ${response.data.length.toLocaleString()} packets...`;
        this.notifyListeners();
        
        const beforeCount = this.packets.size;
        this.mergePackets(response.data);
        this.meta.backgroundLoadComplete = true;
        this.saveToStorage();
        console.log(`[PacketCache] Background load: +${this.packets.size - beforeCount} packets, total: ${this.packets.size}`);
      }
    } catch (error) {
      console.error('[PacketCache] Background load failed:', error);
      this.statusMessage = 'Background load failed';
    } finally {
      this.isBackgroundLoading = false;
      this.statusMessage = '';
      this.notifyListeners();
    }
  }

  /**
   * Deep load: 50K packets for comprehensive topology analysis.
   * User-triggered via "Deep Analysis" button.
   */
  async deepLoad(): Promise<void> {
    if (this.meta.deepLoadComplete || this.isDeepLoading) {
      return;
    }
    return this.doDeepLoad();
  }

  /**
   * Force deep load: Always fetch 50K, even if already complete.
   * Used by "Deep Analysis" button to refresh topology data.
   */
  async forceDeepLoad(): Promise<void> {
    if (this.isDeepLoading) {
      return; // Already in progress
    }
    // Reset deepLoadComplete to allow re-fetch
    this.meta.deepLoadComplete = false;
    return this.doDeepLoad();
  }

  /**
   * Internal deep load implementation
   */
  private async doDeepLoad(): Promise<void> {

    this.isDeepLoading = true;
    this.statusMessage = 'Fetching topology data...';
    this.notifyListeners();

    try {
      // Update status periodically while fetching (fetch can take 5-15 seconds)
      const statusInterval = setInterval(() => {
        if (this.isDeepLoading) {
          this.statusMessage = `Loading ${DEEP_FETCH_LIMIT.toLocaleString()} packets...`;
          this.notifyListeners();
        }
      }, 500);

      const response = await this.fetchRecentPackets(DEEP_FETCH_LIMIT);
      clearInterval(statusInterval);
      
      if (response.success && response.data) {
        this.statusMessage = `Processing ${response.data.length.toLocaleString()} packets...`;
        this.notifyListeners();
        
        const beforeCount = this.packets.size;
        this.mergePackets(response.data);
        this.meta.deepLoadComplete = true;
        this.saveToStorage();
        console.log(`[PacketCache] Deep load: +${this.packets.size - beforeCount} packets, total: ${this.packets.size}`);
      }
    } catch (error) {
      console.error('[PacketCache] Deep load failed:', error);
      this.statusMessage = 'Deep load failed';
    } finally {
      this.isDeepLoading = false;
      this.statusMessage = '';
      this.notifyListeners();
    }
  }

  /**
   * Poll: Incremental fetch for new packets (smaller request)
   */
  async poll(): Promise<Packet[]> {
    try {
      const response = await this.fetchRecentPackets(POLL_LIMIT);
      
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
      packetCount: 0,
      backgroundLoadComplete: false,
      deepLoadComplete: false,
    };
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

  private async fetchRecentPackets(limit = 1000): Promise<{ success: boolean; data?: Packet[] }> {
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
