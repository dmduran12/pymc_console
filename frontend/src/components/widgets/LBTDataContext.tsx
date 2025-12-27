/**
 * LBTDataContext - Shared data context for LBT Insights widgets
 *
 * Computes LBT (Listen Before Talk) statistics client-side from packet data.
 * 
 * ARCHITECTURE:
 * This context consumes data from the centralized Zustand store rather than
 * polling independently. It only computes derived LBT statistics from the
 * shared packet/stats data.
 * 
 * COMPUTED STATISTICS:
 * - lbtStats: retry rate, busy events, backoff times from packet LBT fields
 * - noiseFloor: current noise floor from stats
 * - linkQuality: computed from TRUE zero-hop neighbors (QuickNeighbors)
 * - channelHealth: composite score combining all above
 * - trends: historical comparison for trend indicators
 *
 * LBT fields in packet records:
 * - lbt_attempts: number of CAD checks before TX (1 = clean channel)
 * - lbt_backoff_delays_ms: JSON array of backoff delays "[192.0, 314.0]"
 * - lbt_channel_busy: boolean (true if TX failed due to channel busy)
 * 
 * NEIGHBOR DETECTION:
 * Uses QuickNeighbors from the centralized store - these are TRUE zero-hop
 * neighbors detected by receiving ADVERTs where they were the last hop.
 * This is the standard letsme.sh / meshcoretomqtt approach.
 */

import { createContext, useContext, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { useStats, usePackets, useQuickNeighbors, type QuickNeighbor } from '@/lib/stores/useStore';
import type { Packet, Stats, NeighborInfo } from '@/types/api';

/** LBT Statistics computed from packets */
export interface ComputedLBTStats {
  // Retry metrics
  totalPacketsWithLBT: number;
  packetsWithRetries: number; // lbt_attempts > 1
  retryRate: number; // % of packets that needed CAD retries
  avgRetries: number; // average lbt_attempts when > 1

  // Channel busy metrics
  channelBusyCount: number; // packets where lbt_channel_busy = true
  channelBusyRate: number; // % of packets that failed due to busy

  // Backoff timing
  avgBackoffMs: number; // average backoff delay
  maxBackoffMs: number; // maximum observed backoff
  totalBackoffMs: number; // sum of all backoffs

  // Hourly breakdown for sparklines
  hourlyRetryRates: number[]; // 24 values, one per hour

  // Time window
  windowHours: number;
  packetCount: number;
}

/** Link quality computed from TRUE zero-hop neighbors (QuickNeighbors) */
export interface ComputedLinkQuality {
  neighbors: Array<{
    name: string;
    hash: string;
    rssi: number;
    snr: number;
    score: number; // 0-100 composite quality
    advertCount: number; // Number of ADVERTs received from this neighbor
  }>;
  networkScore: number; // average of all neighbor scores
  neighborCount: number; // TRUE zero-hop neighbor count
  bestLink: { name: string; score: number } | null;
  worstLink: { name: string; score: number } | null;
}

/** Composite channel health */
export interface ComputedChannelHealth {
  score: number; // 0-100 composite health
  status: 'excellent' | 'good' | 'fair' | 'congested' | 'critical';
  components: {
    lbtHealth: number; // based on retry rate (lower is better)
    noiseHealth: number; // based on noise floor
    linkHealth: number; // based on network score
  };
}

/** Trend direction for widgets */
export type TrendDirection = 'up' | 'down' | 'stable';

/** Historical values for trend computation */
export interface TrendData {
  noiseFloor: { current: number | null; previous: number | null; trend: TrendDirection };
  networkScore: { current: number; previous: number | null; trend: TrendDirection };
  channelHealth: { current: number; previous: number | null; trend: TrendDirection };
}

/** Context data shape */
export interface LBTData {
  // Computed stats
  lbtStats: ComputedLBTStats | null;
  noiseFloor: number | null; // dBm from stats
  linkQuality: ComputedLinkQuality | null;
  channelHealth: ComputedChannelHealth | null;

  // Trend data for widgets
  trends: TrendData | null;

  // Raw data references
  stats: Stats | null;
  recentPackets: Packet[];
  quickNeighbors: QuickNeighbor[]; // TRUE zero-hop neighbors

  // Loading states
  isLoading: boolean;

  // Error state
  error: string | null;

  // Manual refresh
  refresh: () => Promise<void>;
}

const defaultData: LBTData = {
  lbtStats: null,
  noiseFloor: null,
  linkQuality: null,
  channelHealth: null,
  trends: null,
  stats: null,
  recentPackets: [],
  quickNeighbors: [],
  isLoading: true,
  error: null,
  refresh: async () => {},
};

const LBTDataContext = createContext<LBTData>(defaultData);

/**
 * Parse lbt_backoff_delays_ms JSON string to array of numbers
 */
function parseBackoffDelays(delaysStr: string | undefined): number[] {
  if (!delaysStr) return [];
  try {
    const parsed = JSON.parse(delaysStr);
    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter(n => !isNaN(n));
    }
  } catch {
    // Invalid JSON, ignore
  }
  return [];
}

/**
 * Compute link quality score from SNR and RSSI
 * Score 0-100 where 100 is excellent
 */
function computeLinkScore(snr: number | undefined, rssi: number | undefined): number {
  // SNR scoring (typically -20 to +15 dB for LoRa)
  // >10 = excellent, 5-10 = good, 0-5 = fair, -5-0 = poor, <-5 = critical
  let snrScore = 50;
  if (snr !== undefined) {
    if (snr >= 10) snrScore = 100;
    else if (snr >= 5) snrScore = 80;
    else if (snr >= 0) snrScore = 60;
    else if (snr >= -5) snrScore = 40;
    else snrScore = 20;
  }

  // RSSI scoring (typically -120 to -50 dBm)
  // >-70 = excellent, -80 to -70 = good, -90 to -80 = fair, -100 to -90 = poor, <-100 = critical
  let rssiScore = 50;
  if (rssi !== undefined) {
    if (rssi >= -70) rssiScore = 100;
    else if (rssi >= -80) rssiScore = 80;
    else if (rssi >= -90) rssiScore = 60;
    else if (rssi >= -100) rssiScore = 40;
    else rssiScore = 20;
  }

  // Weight SNR more heavily (60/40) as it's more indicative of link quality
  return Math.round(snrScore * 0.6 + rssiScore * 0.4);
}

/**
 * Compute LBT stats from packet array
 */
function computeLBTStats(packets: Packet[], windowHours: number): ComputedLBTStats {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - (windowHours * 3600);

  // Filter to packets within window that have LBT data (transmitted packets)
  const lbtPackets = packets.filter(p => 
    p.timestamp >= cutoff && 
    p.lbt_attempts !== undefined && 
    p.lbt_attempts > 0
  );

  const totalPacketsWithLBT = lbtPackets.length;
  const packetsWithRetries = lbtPackets.filter(p => (p.lbt_attempts ?? 0) > 1).length;
  const retryRate = totalPacketsWithLBT > 0 ? (packetsWithRetries / totalPacketsWithLBT) * 100 : 0;

  // Average retries (only counting packets that had retries)
  const retriedPackets = lbtPackets.filter(p => (p.lbt_attempts ?? 0) > 1);
  const avgRetries = retriedPackets.length > 0
    ? retriedPackets.reduce((sum, p) => sum + (p.lbt_attempts ?? 0), 0) / retriedPackets.length
    : 0;

  // Channel busy count
  const channelBusyCount = lbtPackets.filter(p => 
    p.lbt_channel_busy === true || p.lbt_channel_busy === 1
  ).length;
  const channelBusyRate = totalPacketsWithLBT > 0 ? (channelBusyCount / totalPacketsWithLBT) * 100 : 0;

  // Backoff timing
  const allBackoffs: number[] = [];
  for (const p of lbtPackets) {
    const delays = parseBackoffDelays(p.lbt_backoff_delays_ms);
    allBackoffs.push(...delays);
  }
  const totalBackoffMs = allBackoffs.reduce((sum, d) => sum + d, 0);
  const avgBackoffMs = allBackoffs.length > 0 ? totalBackoffMs / allBackoffs.length : 0;
  const maxBackoffMs = allBackoffs.length > 0 ? Math.max(...allBackoffs) : 0;

  // Hourly breakdown for sparklines
  const hourlyRetryRates: number[] = [];
  for (let h = 0; h < 24; h++) {
    const hourStart = now - ((24 - h) * 3600);
    const hourEnd = hourStart + 3600;
    const hourPackets = lbtPackets.filter(p => p.timestamp >= hourStart && p.timestamp < hourEnd);
    const hourRetried = hourPackets.filter(p => (p.lbt_attempts ?? 0) > 1).length;
    const rate = hourPackets.length > 0 ? (hourRetried / hourPackets.length) * 100 : 0;
    hourlyRetryRates.push(rate);
  }

  return {
    totalPacketsWithLBT,
    packetsWithRetries,
    retryRate,
    avgRetries,
    channelBusyCount,
    channelBusyRate,
    avgBackoffMs,
    maxBackoffMs,
    totalBackoffMs,
    hourlyRetryRates,
    windowHours,
    packetCount: packets.length,
  };
}

/**
 * Compute link quality from TRUE zero-hop neighbors (QuickNeighbors)
 * 
 * This uses the standard letsme.sh / meshcoretomqtt approach:
 * A neighbor is a node where we received ADVERTs with them as the LAST HOP.
 * 
 * @param quickNeighbors - True zero-hop neighbors from store
 * @param allContacts - All contacts for name resolution
 */
function computeLinkQuality(
  quickNeighbors: QuickNeighbor[],
  allContacts: Record<string, NeighborInfo>
): ComputedLinkQuality {
  if (quickNeighbors.length === 0) {
    return {
      neighbors: [],
      networkScore: 0,
      neighborCount: 0,
      bestLink: null,
      worstLink: null,
    };
  }

  const neighborList = quickNeighbors.map((qn) => {
    // Use QuickNeighbor's direct RSSI/SNR measurements (from ADVERTs)
    const score = computeLinkScore(qn.avgSnr ?? undefined, qn.avgRssi ?? undefined);
    // Get name from all contacts
    const contact = allContacts[qn.hash];
    const name = contact?.name || contact?.node_name || qn.prefix;
    return {
      name,
      hash: qn.hash,
      rssi: qn.avgRssi ?? -100,
      snr: qn.avgSnr ?? -10,
      score,
      advertCount: qn.count,
    };
  });

  // Sort by score descending
  neighborList.sort((a, b) => b.score - a.score);

  const networkScore = neighborList.length > 0
    ? neighborList.reduce((sum, n) => sum + n.score, 0) / neighborList.length
    : 0;

  return {
    neighbors: neighborList,
    networkScore: Math.round(networkScore),
    neighborCount: neighborList.length,
    bestLink: neighborList.length > 0 ? { name: neighborList[0].name, score: neighborList[0].score } : null,
    worstLink: neighborList.length > 0 ? { name: neighborList[neighborList.length - 1].name, score: neighborList[neighborList.length - 1].score } : null,
  };
}

/**
 * Compute composite channel health
 */
function computeChannelHealth(
  lbtStats: ComputedLBTStats | null,
  noiseFloor: number | null,
  linkQuality: ComputedLinkQuality | null
): ComputedChannelHealth {
  // LBT health: 100 = 0% retries, 0 = >20% retries
  const lbtHealth = lbtStats
    ? Math.max(0, Math.min(100, 100 - (lbtStats.retryRate * 5)))
    : 50;

  // Noise health: based on noise floor dBm
  // -120 dBm = excellent (100), -90 dBm = poor (0)
  let noiseHealth = 50;
  if (noiseFloor !== null) {
    noiseHealth = Math.max(0, Math.min(100, ((noiseFloor + 120) / 30) * 100));
  }

  // Link health: network score directly
  const linkHealth = linkQuality?.networkScore ?? 50;

  // Composite: weight LBT and link more heavily
  const score = Math.round(lbtHealth * 0.35 + noiseHealth * 0.25 + linkHealth * 0.40);

  // Status thresholds
  let status: ComputedChannelHealth['status'];
  if (score >= 85) status = 'excellent';
  else if (score >= 70) status = 'good';
  else if (score >= 50) status = 'fair';
  else if (score >= 30) status = 'congested';
  else status = 'critical';

  return {
    score,
    status,
    components: {
      lbtHealth: Math.round(lbtHealth),
      noiseHealth: Math.round(noiseHealth),
      linkHealth: Math.round(linkHealth),
    },
  };
}

/**
 * Compute trend direction from current and previous values
 * @param current - Current value
 * @param previous - Previous value (null if no history)
 * @param threshold - Minimum change to register as up/down (default 2%)
 * @param invertDirection - If true, higher values mean "down" trend (e.g., noise floor)
 */
function computeTrend(
  current: number,
  previous: number | null,
  threshold: number = 2,
  invertDirection: boolean = false
): TrendDirection {
  if (previous === null) return 'stable';
  
  const delta = current - previous;
  const percentChange = previous !== 0 ? Math.abs(delta / previous) * 100 : Math.abs(delta);
  
  if (percentChange < threshold) return 'stable';
  
  // For inverted metrics (like noise floor), higher = worse = "up" trend
  if (invertDirection) {
    return delta > 0 ? 'up' : 'down';
  }
  
  // For normal metrics (like health score), higher = better = "down" trend (improving)
  // Note: In our trend display, "up" means worse, "down" means better
  return delta > 0 ? 'down' : 'up';
}

export interface LBTDataProviderProps {
  children: ReactNode;
}

/**
 * LBTDataProvider - Computes LBT statistics from centralized store data
 * 
 * NOTE: This provider does NOT poll for data. It consumes stats and packets
 * from the centralized Zustand store, which handles all polling.
 * Only derived computations are performed here.
 * 
 * NEIGHBOR DATA:
 * Uses QuickNeighbors for link quality - these are TRUE zero-hop neighbors
 * detected by receiving ADVERTs where they were the last hop.
 */
export function LBTDataProvider({ children }: LBTDataProviderProps) {
  // Consume data from centralized store (polling handled at App level)
  const stats = useStats();
  const packets = usePackets();
  const quickNeighbors = useQuickNeighbors();
  
  // Derived loading state - we're "loading" if store hasn't populated data yet
  const isLoading = stats === null;

  // Compute derived LBT statistics from store data
  const lbtStats = useMemo(() => computeLBTStats(packets, 24), [packets]);
  const noiseFloor = stats?.noise_floor_dbm ?? null;
  
  // Memoize allContacts to prevent useMemo dependency churn
  const neighbors = stats?.neighbors;
  const allContacts = useMemo(() => neighbors ?? {}, [neighbors]);
  
  // Use QuickNeighbors for TRUE zero-hop neighbor link quality
  const linkQuality = useMemo(
    () => computeLinkQuality(quickNeighbors, allContacts),
    [quickNeighbors, allContacts]
  );
  
  const channelHealth = useMemo(
    () => computeChannelHealth(lbtStats, noiseFloor, linkQuality),
    [lbtStats, noiseFloor, linkQuality]
  );
  
  // Track previous values for trend computation
  // Use state for values (triggers re-render when trends should update)
  // Use ref for timing (no cascading render issues)
  const [prevValues, setPrevValues] = useState<{
    noiseFloor: number | null;
    networkScore: number | null;
    channelHealth: number | null;
  }>({ noiseFloor: null, networkScore: null, channelHealth: null });
  const lastUpdateRef = useRef<number>(0);
  
  // Update previous values every 30 seconds using an interval
  // This avoids the cascading render issue from calling setState in useEffect
  useEffect(() => {
    const checkAndUpdate = () => {
      const now = Date.now();
      if (now - lastUpdateRef.current > 30000) {
        lastUpdateRef.current = now;
        setPrevValues({
          noiseFloor: noiseFloor,
          networkScore: linkQuality?.networkScore ?? null,
          channelHealth: channelHealth?.score ?? null,
        });
      }
    };
    
    // Check immediately on mount
    checkAndUpdate();
    
    // Set up interval to check periodically
    const interval = setInterval(checkAndUpdate, 5000);
    return () => clearInterval(interval);
  }, [noiseFloor, linkQuality?.networkScore, channelHealth?.score]);
  
  // Compute trends by comparing current to previous values
  const trends = useMemo((): TrendData => {
    return {
      noiseFloor: {
        current: noiseFloor,
        previous: prevValues.noiseFloor,
        // Noise floor: lower is better, so increasing = worse = "up"
        trend: noiseFloor !== null 
          ? computeTrend(noiseFloor, prevValues.noiseFloor, 2, true) 
          : 'stable',
      },
      networkScore: {
        current: linkQuality?.networkScore ?? 0,
        previous: prevValues.networkScore,
        // Network score: higher is better, so increasing = better = "down"
        trend: computeTrend(linkQuality?.networkScore ?? 0, prevValues.networkScore, 3, false),
      },
      channelHealth: {
        current: channelHealth?.score ?? 0,
        previous: prevValues.channelHealth,
        // Channel health: higher is better, so increasing = better = "down"
        trend: computeTrend(channelHealth?.score ?? 0, prevValues.channelHealth, 3, false),
      },
    };
  }, [noiseFloor, linkQuality?.networkScore, channelHealth?.score, prevValues]);

  // Refresh is now a no-op since polling is centralized
  // Kept for API compatibility
  const refresh = async () => {};

  const value: LBTData = {
    lbtStats,
    noiseFloor,
    linkQuality,
    channelHealth,
    trends,
    stats,
    recentPackets: packets,
    quickNeighbors,
    isLoading,
    error: null, // Errors handled at store level
    refresh,
  };

  return <LBTDataContext.Provider value={value}>{children}</LBTDataContext.Provider>;
}

/**
 * Hook to access LBT data from context
 */
export function useLBTData(): LBTData {
  const context = useContext(LBTDataContext);
  if (context === undefined) {
    throw new Error('useLBTData must be used within an LBTDataProvider');
  }
  return context;
}

export default LBTDataContext;
