/**
 * Central Zustand Store - Single source of truth for app state
 * 
 * ARCHITECTURE:
 * - All data polling is centralized here (stats, packets)
 * - Components subscribe to granular selectors to minimize re-renders
 * - Heavy computation (topology) offloaded to Web Worker via topologyService
 * 
 * POLLING STRATEGY:
 * - Stats: Every 3 seconds (lightweight API call)
 * - Packets: Every 3 seconds via packet cache (incremental)
 * - Components should NOT poll independently - subscribe to this store
 */

import { create } from 'zustand';
import type { Stats, Packet, LogEntry, NeighborInfo } from '@/types/api';
import * as api from '@/lib/api';
import { packetCache, type PacketCacheState } from '@/lib/packet-cache';
import { topologyService } from '@/lib/topology-service';
import { sparklineService } from '@/lib/sparkline-service';
import { getHashPrefix } from '@/lib/path-utils';
import { POLLING_INTERVALS } from '@/lib/constants';

/** Data point for system resource history */
export interface ResourceDataPoint {
  timestamp: number;
  time: string;
  cpu: number;
  memory: number;
}

// localStorage key for resource history persistence
const RESOURCE_HISTORY_KEY = 'pymc-resource-history';
const RESOURCE_LAST_FETCH_KEY = 'pymc-resource-last-fetch';
const HIDDEN_CONTACTS_KEY = 'pymc-hidden-contacts';
const QUICK_NEIGHBORS_KEY = 'pymc-quick-neighbors';

// ═══════════════════════════════════════════════════════════════════════════════
// NEIGHBOR DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module implements MeshCore-compatible zero-hop neighbor detection.
//
// BACKGROUND:
// A "neighbor" in MeshCore terminology is a node we can reach via direct RF
// contact (zero-hop). This is determined by receiving ADVERT packets with
// path_len == 0, meaning no intermediate nodes forwarded the packet.
//
// ALGORITHM SOURCE:
// MeshCore's MyMesh.cpp onAdvertRecv():
//   if (packet->path_len == 0 && !isShare(packet)) {
//     putNeighbour(id, timestamp, packet->getSNR());
//   }
//
// NOTE: This differs from pyMC_Repeater's backend which uses route_type==2
// (DIRECT) to set zero_hop. Our frontend uses the MeshCore algorithm for
// consistency with user expectations from the MeshCore mental model.
//
// FRESHNESS:
// Neighbors are tracked with freshness status to identify stale links:
// - active:  heard within 7 days (shown normally)
// - stale:   7-14 days ago (shown with "Idle MM/DD" indicator)
// - expired: >14 days (excluded from neighbor list entirely)
//
// ═══════════════════════════════════════════════════════════════════════════════

/** Neighbor freshness status based on last seen timestamp */
export type NeighborStatus = 'active' | 'stale' | 'expired';

/** Time thresholds for neighbor freshness classification (milliseconds) */
const NEIGHBOR_FRESHNESS = {
  ACTIVE_THRESHOLD_MS: 7 * 24 * 60 * 60 * 1000,   // 7 days
  STALE_THRESHOLD_MS: 14 * 24 * 60 * 60 * 1000,   // 14 days
} as const;

/** MeshCore packet type constants */
const MESHCORE_PACKET_TYPES = {
  ADVERT: 0x04,  // PAYLOAD_TYPE_ADVERT from MeshCore Packet.h
} as const;

/**
 * A zero-hop neighbor detected from ADVERT packets with path_len == 0.
 * 
 * This represents direct RF contact - the node transmitted and we received
 * without any intermediate forwarders.
 */
export interface QuickNeighbor {
  /** Full node hash (e.g., "61a73fe9731d3e...") */
  hash: string;
  
  /** 2-char prefix from hash (e.g., "61") */
  prefix: string;
  
  /** Count of zero-hop ADVERT packets received from this neighbor */
  count: number;
  
  /** Average RSSI across received ADVERTs (dBm), null if no data */
  avgRssi: number | null;
  
  /** Average SNR across received ADVERTs (dB), null if no data */
  avgSnr: number | null;
  
  /** Unix timestamp (seconds) of most recent zero-hop ADVERT */
  lastSeen: number;
  
  /** Freshness status: active (<7d), stale (7-14d), or expired (>14d) */
  status: NeighborStatus;
}

/** Internal accumulator for neighbor signal statistics */
interface NeighborStatsAccumulator {
  hash: string;
  count: number;
  rssiSum: number;
  rssiCount: number;
  snrSum: number;
  snrCount: number;
  lastSeen: number;
}

/**
 * Determine neighbor freshness status from last seen timestamp.
 * 
 * @param lastSeenSec - Unix timestamp in seconds
 * @param nowMs - Current time in milliseconds
 * @returns Freshness status
 */
function getNeighborStatus(lastSeenSec: number, nowMs: number): NeighborStatus {
  const ageMs = nowMs - (lastSeenSec * 1000);
  
  if (ageMs <= NEIGHBOR_FRESHNESS.ACTIVE_THRESHOLD_MS) return 'active';
  if (ageMs <= NEIGHBOR_FRESHNESS.STALE_THRESHOLD_MS) return 'stale';
  return 'expired';
}

/**
 * Build a prefix-to-hash lookup map from known neighbors.
 * 
 * When multiple neighbors share the same 2-char prefix (collision),
 * prefer the one marked as zero_hop by the backend.
 * 
 * @param neighbors - Known contacts from stats.neighbors
 * @returns Map of 2-char prefix to full hash
 */
function buildPrefixLookup(neighbors: Record<string, NeighborInfo>): Map<string, string> {
  const prefixToHash = new Map<string, string>();
  
  for (const hash of Object.keys(neighbors)) {
    const prefix = getHashPrefix(hash);
    const existing = prefixToHash.get(prefix);
    
    if (!existing) {
      prefixToHash.set(prefix, hash);
    } else {
      // Collision: prefer the one with zero_hop=true from backend
      const currentIsZeroHop = neighbors[existing]?.zero_hop;
      const newIsZeroHop = neighbors[hash]?.zero_hop;
      if (newIsZeroHop && !currentIsZeroHop) {
        prefixToHash.set(prefix, hash);
      }
    }
  }
  
  return prefixToHash;
}

/**
 * Check if a packet is a zero-hop ADVERT (MeshCore neighbor criteria).
 * 
 * @param packet - Packet to check
 * @returns true if this is a received ADVERT with path_len == 0
 */
function isZeroHopAdvert(packet: Packet): boolean {
  // Must be an ADVERT packet
  const payloadType = packet.type ?? packet.payload_type;
  if (payloadType !== MESHCORE_PACKET_TYPES.ADVERT) return false;
  
  // Must be received (not transmitted by us)
  if (packet.transmitted === true) return false;
  
  // Must have path_len == 0 (zero-hop, direct RF contact)
  const path = packet.original_path;
  const pathLen = Array.isArray(path) ? path.length : 0;
  return pathLen === 0;
}

/**
 * Resolve a packet's src_hash to a full neighbor hash.
 * 
 * API may return src_hash as 2-char prefix ("61") or full hash.
 * This function normalizes to full hash using the prefix lookup.
 * 
 * @param srcHash - Source hash from packet (may be prefix or full)
 * @param localPrefix - Local node's 2-char prefix (to exclude self)
 * @param prefixToHash - Prefix lookup map
 * @param knownHashes - Set of known neighbor hashes
 * @param localHash - Local node's full hash
 * @returns Resolved full hash, or null if unresolvable/self/unknown
 */
function resolveNeighborHash(
  srcHash: string | undefined,
  localPrefix: string,
  prefixToHash: Map<string, string>,
  knownHashes: Set<string>,
  localHash: string
): string | null {
  if (!srcHash) return null;
  
  let resolvedHash = srcHash;
  
  // If short prefix, resolve to full hash
  if (srcHash.length <= 4) {
    const prefix = srcHash.replace(/^0x/i, '').toUpperCase();
    
    // Skip local node
    if (prefix === localPrefix) return null;
    
    const resolved = prefixToHash.get(prefix);
    if (!resolved) return null; // Can't resolve to known neighbor
    
    resolvedHash = resolved;
  }
  
  // Validate against known neighbors and exclude self
  if (!knownHashes.has(resolvedHash)) return null;
  if (resolvedHash === localHash) return null;
  
  return resolvedHash;
}

/**
 * Accumulate signal stats for a neighbor from a packet.
 * 
 * @param stats - Existing stats accumulator (mutated in place)
 * @param packet - Packet to accumulate from
 */
function accumulateNeighborStats(stats: NeighborStatsAccumulator, packet: Packet): void {
  stats.count++;
  
  if (packet.rssi !== undefined && packet.rssi !== null) {
    stats.rssiSum += packet.rssi;
    stats.rssiCount++;
  }
  
  if (packet.snr !== undefined && packet.snr !== null) {
    stats.snrSum += packet.snr;
    stats.snrCount++;
  }
  
  const timestamp = packet.timestamp ?? 0;
  if (timestamp > stats.lastSeen) {
    stats.lastSeen = timestamp;
  }
}

/**
 * Create an empty stats accumulator for a neighbor.
 */
function createEmptyStats(hash: string): NeighborStatsAccumulator {
  return {
    hash,
    count: 0,
    rssiSum: 0,
    rssiCount: 0,
    snrSum: 0,
    snrCount: 0,
    lastSeen: 0,
  };
}

/**
 * Convert accumulated stats to a QuickNeighbor object.
 * 
 * @param stats - Accumulated stats
 * @param nowMs - Current time for freshness calculation
 * @returns QuickNeighbor or null if expired
 */
function statsToQuickNeighbor(stats: NeighborStatsAccumulator, nowMs: number): QuickNeighbor | null {
  const status = getNeighborStatus(stats.lastSeen, nowMs);
  
  // Exclude expired neighbors
  if (status === 'expired') return null;
  
  return {
    hash: stats.hash,
    prefix: getHashPrefix(stats.hash),
    count: stats.count,
    avgRssi: stats.rssiCount > 0 ? stats.rssiSum / stats.rssiCount : null,
    avgSnr: stats.snrCount > 0 ? stats.snrSum / stats.snrCount : null,
    lastSeen: stats.lastSeen,
    status,
  };
}

/**
 * Detect zero-hop neighbors using MeshCore's algorithm.
 * 
 * Scans packets for ADVERT packets with path_len == 0, indicating direct RF
 * contact. Also includes backend's zero_hop contacts as fallback for neighbors
 * whose packets may not be in our local cache.
 * 
 * @param packets - Packet array from cache
 * @param neighbors - Known contacts from stats.neighbors
 * @param localHash - Local node's hash (e.g., "0x19")
 * @returns Array of QuickNeighbor sorted by count desc, excluding expired
 * 
 * @example
 * ```ts
 * const quickNeighbors = detectQuickNeighbors(packets, stats.neighbors, stats.local_hash);
 * // Returns: [{ hash: "61a73...", prefix: "61", count: 15, avgSnr: -7.0, status: "active" }, ...]
 * ```
 */
function detectQuickNeighbors(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash: string | undefined
): QuickNeighbor[] {
  // Early exit if missing required data
  if (!localHash || packets.length === 0 || Object.keys(neighbors).length === 0) {
    return [];
  }
  
  const nowMs = Date.now();
  const localPrefix = getHashPrefix(localHash);
  const knownHashes = new Set(Object.keys(neighbors));
  const prefixToHash = buildPrefixLookup(neighbors);
  
  // ─── PHASE 1: Scan packets for zero-hop ADVERTs ───────────────────────────
  const neighborStats = new Map<string, NeighborStatsAccumulator>();
  
  for (const packet of packets) {
    if (!isZeroHopAdvert(packet)) continue;
    
    const resolvedHash = resolveNeighborHash(
      packet.src_hash,
      localPrefix,
      prefixToHash,
      knownHashes,
      localHash
    );
    if (!resolvedHash) continue;
    
    // Get or create accumulator
    let stats = neighborStats.get(resolvedHash);
    if (!stats) {
      stats = createEmptyStats(resolvedHash);
      neighborStats.set(resolvedHash, stats);
    }
    
    accumulateNeighborStats(stats, packet);
  }
  
  // ─── PHASE 2: Include backend zero_hop contacts as fallback ──────────────
  // This catches neighbors whose packets may not be in our local cache
  for (const [hash, info] of Object.entries(neighbors)) {
    if (info.zero_hop && !neighborStats.has(hash)) {
      neighborStats.set(hash, {
        hash,
        count: info.advert_count ?? 0,
        rssiSum: info.rssi ?? 0,
        rssiCount: info.rssi !== undefined ? 1 : 0,
        snrSum: info.snr ?? 0,
        snrCount: info.snr !== undefined ? 1 : 0,
        lastSeen: info.last_seen ?? 0,
      });
    }
  }
  
  // ─── PHASE 3: Convert to QuickNeighbor array, filter expired ─────────────
  const result: QuickNeighbor[] = [];
  for (const stats of neighborStats.values()) {
    const neighbor = statsToQuickNeighbor(stats, nowMs);
    if (neighbor) result.push(neighbor);
  }
  
  // Sort by packet count (descending), then by recency for ties
  result.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen - a.lastSeen;
  });
  
  return result;
}

/** Load quick neighbors from localStorage */
function loadQuickNeighbors(): QuickNeighbor[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(QUICK_NEIGHBORS_KEY);
    if (stored) {
      return JSON.parse(stored) as QuickNeighbor[];
    }
  } catch {
    // Ignore localStorage errors
  }
  return [];
}

/** Save quick neighbors to localStorage */
function saveQuickNeighbors(neighbors: QuickNeighbor[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(QUICK_NEIGHBORS_KEY, JSON.stringify(neighbors));
  } catch {
    // Ignore localStorage errors
  }
}

/** Load resource history from localStorage */
function loadResourceHistory(): ResourceDataPoint[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RESOURCE_HISTORY_KEY);
    if (stored) {
      return JSON.parse(stored) as ResourceDataPoint[];
    }
  } catch {
    // Ignore localStorage errors (e.g., in SSR or incognito)
  }
  return [];
}

/** Load hidden contacts set from localStorage */
function loadHiddenContacts(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const stored = localStorage.getItem(HIDDEN_CONTACTS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored) as string[]);
    }
  } catch {
    // Ignore localStorage errors
  }
  return new Set();
}

/** Save hidden contacts set to localStorage */
function saveHiddenContacts(hidden: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(HIDDEN_CONTACTS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Ignore localStorage errors
  }
}

/** Load last fetch timestamp from localStorage */
function loadLastResourceFetch(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const stored = localStorage.getItem(RESOURCE_LAST_FETCH_KEY);
    if (stored) {
      return parseInt(stored, 10) || 0;
    }
  } catch {
    // Ignore localStorage errors
  }
  return 0;
}

/** Save resource history to localStorage */
function saveResourceHistory(history: ResourceDataPoint[], lastFetch: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RESOURCE_HISTORY_KEY, JSON.stringify(history));
    localStorage.setItem(RESOURCE_LAST_FETCH_KEY, lastFetch.toString());
  } catch {
    // Ignore localStorage errors (e.g., in SSR or incognito)
  }
}

interface StoreState {
  // Stats
  stats: Stats | null;
  statsLoading: boolean;
  statsError: string | null;

  // Packets
  packets: Packet[];
  packetsLoading: boolean;
  packetsError: string | null;
  lastPacketTimestamp: number; // Track newest packet timestamp to detect new arrivals

  // Logs
  logs: LogEntry[];
  logsLoading: boolean;

  // UI State
  liveMode: boolean;
  
  // Flash events for visual feedback
  flashReceived: number; // Increment to trigger flash
  flashAdvert: number;   // Increment to trigger flash

  // System resource history (persists across page navigation)
  resourceHistory: ResourceDataPoint[];
  lastResourceFetch: number; // Prevent duplicate entries

  // Hidden contacts (user-removed nodes, persisted to localStorage)
  hiddenContacts: Set<string>;

  // Quick neighbors (lightweight detection, persisted to localStorage)
  // These are detected on every poll without requiring deep analysis
  quickNeighbors: QuickNeighbor[];

  // Initialization flag
  initialized: boolean;
  
  // Packet cache state (for topology building UX)
  packetCacheState: PacketCacheState;
  
  // Actions
  initializeApp: () => Promise<void>;
  prefetchForRoute: (route: string) => void;
  fetchStats: () => Promise<void>;
  fetchPackets: (limit?: number) => Promise<void>;
  fetchLogs: () => Promise<void>;
  setLiveMode: (enabled: boolean) => void;
  setMode: (mode: 'forward' | 'monitor') => Promise<void>;
  setDutyCycle: (enabled: boolean) => Promise<void>;
  sendAdvert: () => Promise<boolean>;
  triggerFlashReceived: () => void;
  triggerFlashAdvert: () => void;
  addResourceDataPoint: (cpu: number, memory: number, maxSlots: number) => void;
  hideContact: (hash: string) => void;
  clearPacketCache: () => void;
  triggerTopologyCompute: () => void;
  triggerDeepAnalysis: () => Promise<void>;
  updateQuickNeighbors: () => void;
  triggerSparklineCompute: () => void;
}

const store = create<StoreState>((set, get) => ({
  // Initial state
  stats: null,
  statsLoading: false,
  statsError: null,

  packets: [],
  packetsLoading: false,
  packetsError: null,
  lastPacketTimestamp: 0,

  logs: [],
  logsLoading: false,

  liveMode: true,
  
  flashReceived: 0,
  flashAdvert: 0,

  resourceHistory: loadResourceHistory(),
  lastResourceFetch: loadLastResourceFetch(),
  hiddenContacts: loadHiddenContacts(),
  quickNeighbors: loadQuickNeighbors(),
  initialized: false,
  packetCacheState: packetCache.getState(),

  // Actions
  
  // Initialize app with parallel data fetch for fast startup
  initializeApp: async () => {
    const { initialized } = get();
    if (initialized) return;
    
    set({ initialized: true, statsLoading: true, packetsLoading: true });
    
    // Subscribe to packet cache state changes
    // Update packets when background load (30k) or deep load (50k) completes
    let wasBackgroundLoading = false;
    let wasDeepLoading = false;
    packetCache.subscribe((cacheState) => {
      set({ packetCacheState: cacheState });
      
      // Detect when background load (30k) just finished
      if (wasBackgroundLoading && !cacheState.isBackgroundLoading) {
        const allPackets = packetCache.getPackets();
        if (allPackets.length > 0) {
          set({ packets: allPackets });
          // Recompute topology with full packet set AND update quick neighbors
          get().triggerTopologyCompute();
          get().updateQuickNeighbors();
          // Recompute sparklines with full packet set
          get().triggerSparklineCompute();
        }
      }
      wasBackgroundLoading = cacheState.isBackgroundLoading;
      
      // Detect when deep load (50k) just finished
      if (wasDeepLoading && !cacheState.isDeepLoading) {
        const allPackets = packetCache.getPackets();
        if (allPackets.length > 0) {
          set({ packets: allPackets });
          // Recompute topology with full packet set AND update quick neighbors
          get().triggerTopologyCompute();
          get().updateQuickNeighbors();
          // Recompute sparklines with full packet set
          get().triggerSparklineCompute();
        }
      }
      wasDeepLoading = cacheState.isDeepLoading;
    });
    
    // Fetch stats and quick load packets in parallel
    try {
      const [stats, packets] = await Promise.all([
        api.getStats(),
        packetCache.quickLoad(), // Fast 1K load, triggers 30K background load
      ]);
      
      set({ stats, statsLoading: false });
      
      if (packets.length > 0) {
        const newestTimestamp = Math.max(...packets.map(p => p.timestamp ?? 0));
        set({
          packets,
          packetsLoading: false,
          lastPacketTimestamp: newestTimestamp,
        });
        // Trigger initial topology computation, quick neighbor detection, and sparklines
        get().triggerTopologyCompute();
        get().updateQuickNeighbors();
        get().triggerSparklineCompute();
      } else {
        set({ packetsLoading: false });
      }
    } catch (error) {
      set({
        statsError: error instanceof Error ? error.message : 'Failed to initialize',
        statsLoading: false,
        packetsLoading: false,
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CENTRALIZED POLLING
    // All components should subscribe to this store instead of polling themselves.
    // This prevents redundant API calls and ensures consistent data.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Poll stats every 3 seconds
    setInterval(() => {
      get().fetchStats();
    }, POLLING_INTERVALS.stats);
    
    // Poll packets every 3 seconds (only when liveMode is enabled)
    setInterval(() => {
      if (get().liveMode) {
        get().fetchPackets();
      }
    }, POLLING_INTERVALS.packets);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AUTO-ADVERT ON STARTUP
    // Workaround for radio initialization bug where RX doesn't work until first TX.
    // Send an advert 3 seconds after app init to "wake up" the radio.
    // ═══════════════════════════════════════════════════════════════════════════
    setTimeout(() => {
      get().sendAdvert().catch(() => {
        // Silently ignore errors - this is just a wake-up call
      });
    }, 3000);
  },
  
  // Prefetch data for a route before navigation (called on hover)
  prefetchForRoute: (route: string) => {
    switch (route) {
      case '/logs':
        // Fire and forget - just warm the cache
        api.getLogs().catch(() => {});
        break;
      case '/system':
        api.getHardwareStats().catch(() => {});
        break;
      case '/statistics':
        // Prefetch chart data
        api.getPacketTypeGraphData(3).catch(() => {});
        api.getNoiseFloorHistory(3).catch(() => {});
        break;
      case '/settings':
        api.getRadioPresets().catch(() => {});
        break;
      // Dashboard, Contacts, Packets all use stats which is already loaded
    }
  },

  fetchStats: async () => {
    const { stats: existingStats } = get();
    // Only show loading spinner on initial load (no existing data)
    if (!existingStats) {
      set({ statsLoading: true });
    }
    set({ statsError: null });
    
    try {
      const stats = await api.getStats();
      set({ stats, statsLoading: false });
    } catch (error) {
      set({ 
        statsError: error instanceof Error ? error.message : 'Failed to fetch stats',
        statsLoading: false 
      });
    }
  },

  fetchPackets: async (_limit?: number) => {
    const { packets: existingPackets } = get();
    // Only show loading spinner on initial load
    if (existingPackets.length === 0) {
      set({ packetsLoading: true });
    }
    set({ packetsError: null });
    
    try {
      // Use packet cache for incremental polling
      const newPackets = await packetCache.poll();
      const { lastPacketTimestamp } = get();
      
      // Find newest packet timestamp from response
      const newestTimestamp = newPackets.length > 0 
        ? Math.max(...newPackets.map(p => p.timestamp ?? 0))
        : 0;
      
      // Trigger flash only if we have new packets (newer than last seen)
      // and this isn't the initial load (lastPacketTimestamp > 0)
      if (newestTimestamp > lastPacketTimestamp && lastPacketTimestamp > 0) {
        set({ flashReceived: get().flashReceived + 1 });
      }
      
      set({ 
        packets: newPackets, 
        packetsLoading: false,
        lastPacketTimestamp: newestTimestamp || lastPacketTimestamp,
      });
      // Trigger topology recompute and quick neighbor update on new packets
      get().triggerTopologyCompute();
      get().updateQuickNeighbors();
    } catch (error) {
      set({ 
        packetsError: error instanceof Error ? error.message : 'Failed to fetch packets',
        packetsLoading: false 
      });
    }
  },

  fetchLogs: async () => {
    const { logs: existingLogs } = get();
    // Only show loading spinner on initial load
    if (existingLogs.length === 0) {
      set({ logsLoading: true });
    }
    
    try {
      const response = await api.getLogs();
      set({ logs: response.logs, logsLoading: false });
    } catch {
      set({ logsLoading: false });
    }
  },

  setLiveMode: (enabled) => {
    set({ liveMode: enabled });
  },

  setMode: async (mode) => {
    try {
      const response = await api.setMode(mode);
      if (response.success) {
        // Refresh stats to get updated mode
        await get().fetchStats();
      }
    } catch (error) {
      console.error('Failed to set mode:', error);
    }
  },

  setDutyCycle: async (enabled) => {
    try {
      const response = await api.setDutyCycle(enabled);
      if (response.success) {
        get().fetchStats();
      }
    } catch (error) {
      console.error('Failed to set duty cycle:', error);
    }
  },

  sendAdvert: async () => {
    try {
      const response = await api.sendAdvert();
      if (response.success) {
        // Trigger advert flash on successful send
        set({ flashAdvert: get().flashAdvert + 1 });
      }
      return response.success;
    } catch (error) {
      console.error('Failed to send advert:', error);
      return false;
    }
  },
  
  triggerFlashReceived: () => {
    set({ flashReceived: get().flashReceived + 1 });
  },
  
  triggerFlashAdvert: () => {
    set({ flashAdvert: get().flashAdvert + 1 });
  },

  addResourceDataPoint: (cpu: number, memory: number, maxSlots: number) => {
    const now = Date.now();
    const { lastResourceFetch, resourceHistory } = get();
    
    // Prevent duplicate entries if called multiple times rapidly
    if (now - lastResourceFetch < 1000) return;
    
    const timeStr = new Date(now).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    
    const newEntry: ResourceDataPoint = {
      timestamp: now,
      time: timeStr,
      cpu,
      memory,
    };
    
    const updated = [...resourceHistory, newEntry];
    // Keep only the most recent maxSlots entries
    const trimmed = updated.length > maxSlots ? updated.slice(-maxSlots) : updated;
    
    set({ resourceHistory: trimmed, lastResourceFetch: now });
    
    // Persist to localStorage
    saveResourceHistory(trimmed, now);
  },

  hideContact: (hash: string) => {
    const { hiddenContacts } = get();
    const updated = new Set(hiddenContacts);
    updated.add(hash);
    set({ hiddenContacts: updated });
    saveHiddenContacts(updated);
  },

  clearPacketCache: () => {
    packetCache.clear();
    set({ packets: [], lastPacketTimestamp: 0 });
    // Re-load with quick + deep background load
    packetCache.quickLoad().then((packets) => {
      if (packets.length > 0) {
        const newestTimestamp = Math.max(...packets.map(p => p.timestamp ?? 0));
        set({ packets, lastPacketTimestamp: newestTimestamp });
        get().triggerTopologyCompute();
      }
    });
  },
  
  triggerTopologyCompute: () => {
    const { packets, stats, hiddenContacts } = get();
    if (packets.length === 0 || !stats) return;
    
    // Filter out hidden contacts from neighbors
    const neighbors = stats.neighbors ?? {};
    const visibleNeighbors = Object.fromEntries(
      Object.entries(neighbors).filter(([hash]) => !hiddenContacts.has(hash))
    );
    
    const localHash = stats.local_hash;
    const localLat = stats.config?.repeater?.latitude;
    const localLon = stats.config?.repeater?.longitude;
    
    // Trigger async computation in worker
    topologyService.compute(packets, visibleNeighbors, localHash, localLat, localLon);
  },
  
  triggerDeepAnalysis: async () => {
    // Force deep load (even if already complete)
    await packetCache.forceDeepLoad();
    // Packets will be updated by the subscription in initializeApp
    // Topology compute will be triggered when packets update
  },
  
  updateQuickNeighbors: () => {
    const { packets, stats, hiddenContacts } = get();
    if (packets.length === 0 || !stats) return;
    
    // Filter out hidden contacts from neighbors
    const neighbors = stats.neighbors ?? {};
    const visibleNeighbors = Object.fromEntries(
      Object.entries(neighbors).filter(([hash]) => !hiddenContacts.has(hash))
    );
    
    const localHash = stats.local_hash;
    
    // Run lightweight detection
    const quickNeighbors = detectQuickNeighbors(packets, visibleNeighbors, localHash);
    
    // Only update if changed (avoid unnecessary re-renders)
    const current = get().quickNeighbors;
    if (quickNeighbors.length !== current.length || 
        quickNeighbors.some((n, i) => n.hash !== current[i]?.hash || n.count !== current[i]?.count)) {
      set({ quickNeighbors });
      saveQuickNeighbors(quickNeighbors);
    }
  },
  
  triggerSparklineCompute: () => {
    const { packets, stats, hiddenContacts } = get();
    if (packets.length === 0 || !stats) return;
    
    // Get all visible neighbor hashes for sparkline computation
    const neighbors = stats.neighbors ?? {};
    const visibleHashes = Object.keys(neighbors).filter(hash => !hiddenContacts.has(hash));
    
    if (visibleHashes.length === 0) return;
    
    // Trigger async computation in sparkline worker
    sparklineService.compute(packets, visibleHashes);
  },
}));

// Main store hook (full access)
export const useStore = store;

// Granular selectors for performance - prevents re-renders when unrelated state changes
export const useStats = () => store((s) => s.stats);
export const useStatsLoading = () => store((s) => s.statsLoading);
export const useStatsError = () => store((s) => s.statsError);
export const usePackets = () => store((s) => s.packets);
export const usePacketsLoading = () => store((s) => s.packetsLoading);
export const useLogs = () => store((s) => s.logs);
export const useLogsLoading = () => store((s) => s.logsLoading);
export const useLiveMode = () => store((s) => s.liveMode);
export const useFlashReceived = () => store((s) => s.flashReceived);
export const useFlashAdvert = () => store((s) => s.flashAdvert);

// Individual action selectors (stable references, no re-renders)
export const useInitializeApp = () => store((s) => s.initializeApp);
export const usePrefetchForRoute = () => store((s) => s.prefetchForRoute);
export const useFetchStats = () => store((s) => s.fetchStats);
export const useFetchPackets = () => store((s) => s.fetchPackets);
export const useFetchLogs = () => store((s) => s.fetchLogs);
export const useSetLiveMode = () => store((s) => s.setLiveMode);
export const useSetMode = () => store((s) => s.setMode);
export const useSetDutyCycle = () => store((s) => s.setDutyCycle);
export const useSendAdvert = () => store((s) => s.sendAdvert);
export const useTriggerFlashReceived = () => store((s) => s.triggerFlashReceived);
export const useTriggerFlashAdvert = () => store((s) => s.triggerFlashAdvert);
export const useResourceHistory = () => store((s) => s.resourceHistory);
export const useAddResourceDataPoint = () => store((s) => s.addResourceDataPoint);
export const useHiddenContacts = () => store((s) => s.hiddenContacts);
export const useHideContact = () => store((s) => s.hideContact);
export const usePacketCacheState = () => store((s) => s.packetCacheState);
export const useClearPacketCache = () => store((s) => s.clearPacketCache);
export const useTriggerDeepAnalysis = () => store((s) => s.triggerDeepAnalysis);
export const useQuickNeighbors = () => store((s) => s.quickNeighbors);
