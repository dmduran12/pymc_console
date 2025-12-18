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
const QUICK_FETCH_LIMIT = 1000;  // Fast initial load
const DEEP_FETCH_LIMIT = 20000;  // Background load for full topology (~7 days)
const POLL_LIMIT = 500;          // Incremental polling

export interface PacketCacheMeta {
  oldestTimestamp: number;
  newestTimestamp: number;
  lastUpdated: number;
  packetCount: number;
  deepLoadComplete: boolean;
}

export interface PacketCacheState {
  isLoading: boolean;
  isDeepLoading: boolean;
  packetCount: number;
}

type StateListener = (state: PacketCacheState) => void;

class PacketCache {
  private packets: Map<string, Packet> = new Map(); // Keyed by packet_hash for dedup
  private meta: PacketCacheMeta = {
    oldestTimestamp: 0,
    newestTimestamp: 0,
    lastUpdated: 0,
    packetCount: 0,
    deepLoadComplete: false,
  };
  private isLoading = false;
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

  /**
   * Get current cache state
   */
  getState(): PacketCacheState {
    return {
      isLoading: this.isLoading,
      isDeepLoading: this.isDeepLoading,
      packetCount: this.packets.size,
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
   * Triggers deep load in background automatically
   */
  async quickLoad(): Promise<Packet[]> {
    // If stale (away > 1hr), clear and refetch
    if (this.isStale() && this.packets.size > 0) {
      console.log('[PacketCache] Cache stale, clearing...');
      this.clear();
    }

    // Return cached data immediately if we have any
    if (this.packets.size > 0) {
      // Trigger deep load in background if not done
      if (!this.meta.deepLoadComplete) {
        this.deepLoad();
      }
      return this.getPackets();
    }

    // No cached data - do quick initial load
    this.isLoading = true;
    this.notifyListeners();

    try {
      const response = await this.fetchRecentPackets(QUICK_FETCH_LIMIT);
      
      if (response.success && response.data) {
        this.mergePackets(response.data);
        this.saveToStorage();
        console.log(`[PacketCache] Quick load: ${response.data.length} packets`);
      }
    } catch (error) {
      console.error('[PacketCache] Quick load failed:', error);
    } finally {
      this.isLoading = false;
      this.notifyListeners();
    }

    // Trigger deep load in background
    this.deepLoad();

    return this.getPackets();
  }

  /**
   * Deep load: Background fetch of 20K packets for full topology
   */
  async deepLoad(): Promise<void> {
    if (this.meta.deepLoadComplete || this.isDeepLoading) {
      return;
    }

    this.isDeepLoading = true;
    this.notifyListeners();

    try {
      const response = await this.fetchRecentPackets(DEEP_FETCH_LIMIT);
      
      if (response.success && response.data) {
        const beforeCount = this.packets.size;
        this.mergePackets(response.data);
        this.meta.deepLoadComplete = true;
        this.saveToStorage();
        console.log(`[PacketCache] Deep load: +${this.packets.size - beforeCount} packets, total: ${this.packets.size}`);
      }
    } catch (error) {
      console.error('[PacketCache] Deep load failed:', error);
    } finally {
      this.isDeepLoading = false;
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
