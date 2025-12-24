import { create } from 'zustand';
import type { Stats, Packet, LogEntry, NeighborInfo } from '@/types/api';
import * as api from '@/lib/api';
import { packetCache, type PacketCacheState } from '@/lib/packet-cache';
import { topologyService } from '@/lib/topology-service';
import { parsePacketPath, getHashPrefix } from '@/lib/path-utils';

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

/**
 * Minimum packets required in EACH direction to confirm bidirectional neighbor.
 * A node is a confirmed bidirectional neighbor when:
 * - We received >= MIN_BIDIRECTIONAL_THRESHOLD packets FROM them (they TX'd, we RX'd)
 * - We transmitted >= MIN_BIDIRECTIONAL_THRESHOLD packets TO them (we TX'd, they forwarded)
 * 
 * Using 2 as threshold to avoid false positives from single packet observations.
 */
export const MIN_BIDIRECTIONAL_THRESHOLD = 2;

// ═══════════════════════════════════════════════════════════════════════════════
// Quick Neighbor Types (lightweight detection without deep analysis)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A neighbor detected through bidirectional packet exchange.
 * 
 * BIDIRECTIONALITY REQUIREMENT:
 * A true "neighbor" (point-to-point, zero-hop) must exhibit two-way communication:
 * - RX Direction: They transmitted, we received (their TX → our RX)
 * - TX Direction: We transmitted, they forwarded (our TX → their RX → they forward)
 * 
 * Only ADVERT packets (type=4) are used for neighbor detection because:
 * - ADVERTs are periodic broadcasts representing the purest signal quality indicator
 * - Other packet types may be forwarded with different TX power/conditions
 * 
 * This ensures we only mark nodes as neighbors when we have CONFIRMED two-way RF link.
 */
export interface QuickNeighbor {
  /** Full hash of the neighbor (matched from known contacts) */
  hash: string;
  /** 2-char prefix as seen in packet paths */
  prefix: string;
  /** @deprecated Use rxCount instead. Total ADVERT count (legacy, equals rxCount) */
  count: number;
  /** Number of ADVERT packets RECEIVED from this neighbor (they TX'd → we RX'd) */
  rxCount: number;
  /** Number of ADVERT packets TRANSMITTED where this neighbor forwarded (we TX'd → they forwarded) */
  txCount: number;
  /** True if bidirectional communication confirmed (both rxCount and txCount >= threshold) */
  isBidirectional: boolean;
  /** Average RSSI of ADVERT packets received from this neighbor */
  avgRssi: number | null;
  /** Average SNR of ADVERT packets received from this neighbor */
  avgSnr: number | null;
  /** Most recent ADVERT timestamp from this neighbor */
  lastSeen: number;
}

/**
 * Lightweight bidirectional neighbor detection from ADVERT packets.
 * Runs on main thread with polled packets - no deep analysis needed.
 * 
 * BIDIRECTIONALITY REQUIREMENT:
 * A neighbor is only confirmed when BOTH directions are observed:
 * - RX Direction: We received ADVERT packets where they were last hop (they TX'd → we RX'd)
 * - TX Direction: We transmitted ADVERT packets where they were first hop (we TX'd → they forwarded)
 * 
 * Only ADVERT packets (type=4) are used because they represent the purest
 * signal quality indicator - periodic broadcasts with consistent TX parameters.
 * 
 * @param packets - Packet array (even small poll batches work)
 * @param neighbors - Known contacts from stats.neighbors
 * @param localHash - Local node's hash (e.g., "0x19")
 * @returns Array of QuickNeighbor sorted by total packet count (RX + TX) descending
 */
function detectQuickNeighbors(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash: string | undefined
): QuickNeighbor[] {
  if (!localHash || packets.length === 0 || Object.keys(neighbors).length === 0) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[quickNeighbors] Early return:', { localHash, packetCount: packets.length, neighborCount: Object.keys(neighbors).length });
    }
    return [];
  }
  
  // Build prefix → hash lookup from known neighbors
  // For collisions, prefer the neighbor with valid coordinates (more likely to be real)
  const prefixToHash = new Map<string, string>();
  const prefixCollisions = new Map<string, string[]>(); // Track all hashes per prefix
  
  for (const hash of Object.keys(neighbors)) {
    const prefix = getHashPrefix(hash);
    if (!prefixCollisions.has(prefix)) {
      prefixCollisions.set(prefix, [hash]);
    } else {
      prefixCollisions.get(prefix)!.push(hash);
    }
  }
  
  // For each prefix, pick the best hash (prefer one with coordinates)
  for (const [prefix, hashes] of prefixCollisions) {
    if (hashes.length === 1) {
      // No collision - use directly
      prefixToHash.set(prefix, hashes[0]);
    } else {
      // Collision - try to disambiguate by picking the one with valid coordinates
      const withCoords = hashes.filter(h => {
        const n = neighbors[h];
        return n && n.latitude && n.longitude && n.latitude !== 0 && n.longitude !== 0;
      });
      
      if (withCoords.length === 1) {
        // Only one has coords - use it
        prefixToHash.set(prefix, withCoords[0]);
      } else if (withCoords.length > 1) {
        // Multiple have coords - pick most recently seen
        const sorted = withCoords.sort((a, b) => {
          const lastA = neighbors[a]?.last_seen ?? 0;
          const lastB = neighbors[b]?.last_seen ?? 0;
          return lastB - lastA;
        });
        prefixToHash.set(prefix, sorted[0]);
      } else {
        // None have coords - pick most recently seen
        const sorted = hashes.sort((a, b) => {
          const lastA = neighbors[a]?.last_seen ?? 0;
          const lastB = neighbors[b]?.last_seen ?? 0;
          return lastB - lastA;
        });
        prefixToHash.set(prefix, sorted[0]);
      }
    }
  }
  
  if (process.env.NODE_ENV === 'development') {
    const collisionCount = [...prefixCollisions.values()].filter(h => h.length > 1).length;
    console.log('[quickNeighbors] Built prefix lookup:', prefixToHash.size, 'prefixes,', collisionCount, 'collisions resolved');
  }
  
  // Track neighbor stats for BOTH directions
  // RX = packets we received from them (they TX'd → we RX'd)
  // TX = packets we transmitted that they forwarded (we TX'd → they forwarded)
  const neighborStats = new Map<string, {
    hash: string;
    rxCount: number;      // Packets received from them (last hop)
    txCount: number;      // Packets transmitted where they were first hop
    rssiSum: number;      // Only from RX packets (signal we actually received)
    rssiCount: number;
    snrSum: number;       // Only from RX packets
    snrCount: number;
    lastSeen: number;
  }>();
  
  let advertPacketsRx = 0;
  let advertPacketsTx = 0;
  let rxResolved = 0;
  let txResolved = 0;
  
  for (const packet of packets) {
    // Only use ADVERT packets (type=4) for neighbor detection
    // ADVERTs are periodic broadcasts that represent the purest signal quality indicator.
    const packetType = packet.type ?? packet.payload_type;
    if (packetType !== 4) continue;  // Skip non-ADVERT packets
    
    const parsed = parsePacketPath(packet, localHash);
    if (!parsed || parsed.effectiveLength === 0) continue;
    
    const isTransmitted = packet.transmitted === true;
    
    if (isTransmitted) {
      // TX DIRECTION: We transmitted this packet
      // First element in path is the first forwarder (node that received our TX)
      // This proves: our TX → their RX (they can hear us)
      advertPacketsTx++;
      
      const firstHopPrefix = parsed.effective[0];
      const resolvedHash = prefixToHash.get(firstHopPrefix);
      
      if (resolvedHash) {
        txResolved++;
        const existing = neighborStats.get(resolvedHash) || {
          hash: resolvedHash,
          rxCount: 0,
          txCount: 0,
          rssiSum: 0,
          rssiCount: 0,
          snrSum: 0,
          snrCount: 0,
          lastSeen: 0,
        };
        
        existing.txCount++;
        
        const timestamp = packet.timestamp ?? 0;
        if (timestamp > existing.lastSeen) {
          existing.lastSeen = timestamp;
        }
        
        neighborStats.set(resolvedHash, existing);
      }
    } else {
      // RX DIRECTION: We received this packet
      // Last element in path is the last forwarder (transmitted directly to us)
      // This proves: their TX → our RX (we can hear them)
      advertPacketsRx++;
      
      const lastHopPrefix = parsed.effective[parsed.effectiveLength - 1];
      const resolvedHash = prefixToHash.get(lastHopPrefix);
      
      if (resolvedHash) {
        rxResolved++;
        const existing = neighborStats.get(resolvedHash) || {
          hash: resolvedHash,
          rxCount: 0,
          txCount: 0,
          rssiSum: 0,
          rssiCount: 0,
          snrSum: 0,
          snrCount: 0,
          lastSeen: 0,
        };
        
        existing.rxCount++;
        
        // Only accumulate signal stats from RX packets (actual received signal)
        if (packet.rssi !== undefined && packet.rssi !== null) {
          existing.rssiSum += packet.rssi;
          existing.rssiCount++;
        }
        
        if (packet.snr !== undefined && packet.snr !== null) {
          existing.snrSum += packet.snr;
          existing.snrCount++;
        }
        
        const timestamp = packet.timestamp ?? 0;
        if (timestamp > existing.lastSeen) {
          existing.lastSeen = timestamp;
        }
        
        neighborStats.set(resolvedHash, existing);
      }
    }
  }
  
  // Convert to QuickNeighbor array
  const result: QuickNeighbor[] = [];
  for (const [hash, stats] of neighborStats) {
    const isBidirectional = 
      stats.rxCount >= MIN_BIDIRECTIONAL_THRESHOLD && 
      stats.txCount >= MIN_BIDIRECTIONAL_THRESHOLD;
    
    result.push({
      hash,
      prefix: getHashPrefix(hash),
      count: stats.rxCount,  // Legacy: equals rxCount for backward compat
      rxCount: stats.rxCount,
      txCount: stats.txCount,
      isBidirectional,
      avgRssi: stats.rssiCount > 0 ? stats.rssiSum / stats.rssiCount : null,
      avgSnr: stats.snrCount > 0 ? stats.snrSum / stats.snrCount : null,
      lastSeen: stats.lastSeen,
    });
  }
  
  // Sort by total packet count (RX + TX) descending, bidirectional first
  result.sort((a, b) => {
    // Bidirectional neighbors first
    if (a.isBidirectional !== b.isBidirectional) {
      return a.isBidirectional ? -1 : 1;
    }
    // Then by total count
    return (b.rxCount + b.txCount) - (a.rxCount + a.txCount);
  });
  
  if (process.env.NODE_ENV === 'development') {
    const bidirectionalCount = result.filter(n => n.isBidirectional).length;
    console.log('[quickNeighbors] Detected:', result.length, 'neighbors (' + bidirectionalCount + ' bidirectional)');
    console.log('[quickNeighbors] ADVERTs: RX=' + advertPacketsRx + ' (resolved=' + rxResolved + '), TX=' + advertPacketsTx + ' (resolved=' + txResolved + ')');
    if (result.length > 0) {
      console.log('[quickNeighbors] Top neighbors:', result.slice(0, 5).map(n => ({
        hash: n.hash.slice(0, 8),
        prefix: n.prefix,
        rx: n.rxCount,
        tx: n.txCount,
        bidir: n.isBidirectional,
      })));
    }
  }
  
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
        // Trigger initial topology computation and quick neighbor detection
        get().triggerTopologyCompute();
        get().updateQuickNeighbors();
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
