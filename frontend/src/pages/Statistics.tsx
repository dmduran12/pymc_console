import { useEffect, useState, useMemo, useCallback } from 'react';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { useStats } from '@/lib/stores/useStore';
import { BarChart3, TrendingUp, PieChart, Radio, Compass, Network } from 'lucide-react';
import * as api from '@/lib/api';
import type { GraphData } from '@/types/api';
import type { BucketedStats, BucketData, NoiseFloorHistoryItem } from '@/lib/api';
import { TimeRangeSelector } from '@/components/shared/TimeRangeSelector';
import { usePolling } from '@/lib/hooks/usePolling';
import { PacketTypesChart } from '@/components/charts/PacketTypesChart';
import { TrafficStackedChart } from '@/components/charts/TrafficStackedChart';
import { NeighborPolarChart } from '@/components/charts/NeighborPolarChart';
import { NoiseFloorHeatmap } from '@/components/charts/NoiseFloorHeatmap';
import { NetworkCompositionChart } from '@/components/charts/NetworkCompositionChart';
import { STATISTICS_TIME_RANGES } from '@/lib/constants';

// ============================================================================
// Airtime Utilization Data Processing
// ============================================================================

/**
 * FIXED SPIKE WINDOW (W)
 * 
 * Peak utilization is always measured over this fixed window, regardless of
 * time range. This ensures "17% spike" means the same thing in 1H and 7D views.
 * 
 * W = 10s is good for spikey networks (captures short bursts)
 */
const SPIKE_WINDOW_SECONDS = 10;

/** Max display points for chart */
const MAX_DISPLAY_POINTS = 720;

/**
 * Utilization point for chart display.
 * - avg: time-weighted average over display bin (trend)
 * - peak: max instantaneous util from any W-second window (spike intensity)
 */
export interface UtilizationPoint {
  time: string;
  timestamp: number;
  rxAvg: number | null;
  rxPeak: number | null;
  txAvg: number | null;
  txPeak: number | null;
}

/**
 * Time-based rollup with spike preservation.
 * 
 * Key insight: peak is computed from individual W-second buckets,
 * so a 17% spike in a 10s window stays 17% regardless of display bin size.
 */
function rollupSpikePreserving(
  rx: BucketData[],
  tx: BucketData[],
  baseBucketMs: number,  // W in milliseconds
  startTs: number,
  endTs: number,
  targetPoints: number
): UtilizationPoint[] {
  if (endTs <= startTs || targetPoints <= 0 || rx.length === 0) return [];
  
  const rangeMs = (endTs - startTs) * 1000; // convert to ms
  
  // Choose display bin size (multiple of base bucket)
  const approxBinMs = rangeMs / targetPoints;
  const binSizeMs = Math.max(baseBucketMs, Math.ceil(approxBinMs / baseBucketMs) * baseBucketMs);
  const binSizeSec = binSizeMs / 1000;
  
  // Determine time format based on span
  const totalHours = rangeMs / (1000 * 60 * 60);
  const showDate = totalHours > 24;
  
  const result: UtilizationPoint[] = [];
  
  let rxIdx = 0;
  let txIdx = 0;
  
  for (let t0 = startTs; t0 < endTs; t0 += binSizeSec) {
    const t1 = Math.min(endTs, t0 + binSizeSec);
    
    let rxSum = 0, txSum = 0;
    let rxPeak = 0, txPeak = 0;
    let rxCount = 0, txCount = 0;
    
    // Advance rx pointer and collect buckets in [t0, t1)
    while (rxIdx < rx.length && rx[rxIdx].start < t0) rxIdx++;
    let k = rxIdx;
    while (k < rx.length && rx[k].start < t1) {
      const util = (rx[k].airtime_ms / baseBucketMs) * 100;
      if (util > rxPeak) rxPeak = util;
      rxSum += rx[k].airtime_ms;
      rxCount++;
      k++;
    }
    
    // Advance tx pointer and collect buckets in [t0, t1)
    while (txIdx < tx.length && tx[txIdx].start < t0) txIdx++;
    let m = txIdx;
    while (m < tx.length && tx[m].start < t1) {
      const util = (tx[m].airtime_ms / baseBucketMs) * 100;
      if (util > txPeak) txPeak = util;
      txSum += tx[m].airtime_ms;
      txCount++;
      m++;
    }
    
    // Avg = total airtime / bin duration
    const durMs = (t1 - t0) * 1000;
    const rxAvg = rxCount > 0 ? (rxSum / durMs) * 100 : null;
    const txAvg = txCount > 0 ? (txSum / durMs) * 100 : null;
    
    // Format timestamp
    const midTs = Math.floor((t0 + t1) / 2);
    const date = new Date(midTs * 1000);
    let time: string;
    if (showDate) {
      time = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + 
             ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } else {
      time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    
    result.push({
      time,
      timestamp: midTs,
      rxAvg,
      rxPeak: rxCount > 0 ? rxPeak : null,
      txAvg,
      txPeak: txCount > 0 ? txPeak : null,
    });
    
    rxIdx = k;
    txIdx = m;
  }
  
  return result;
}

/**
 * Combine transmitted and forwarded buckets into single TX array.
 */
function combineTxBuckets(transmitted: BucketData[], forwarded: BucketData[]): BucketData[] {
  return transmitted.map((tx, i) => ({
    ...tx,
    count: tx.count + (forwarded[i]?.count ?? 0),
    airtime_ms: tx.airtime_ms + (forwarded[i]?.airtime_ms ?? 0),
  }));
}

// ============================================================================
// Statistics Page Component
// ============================================================================

export default function Statistics() {
  const stats = useStats();
  const [rawBucketedStats, setRawBucketedStats] = useState<BucketedStats | null>(null);
  const [packetTypeData, setPacketTypeData] = useState<GraphData | null>(null);
  const [noiseFloorHistory, setNoiseFloorHistory] = useState<NoiseFloorHistoryItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(3); // Default to 24h

  // Debounce time range changes to prevent rapid API calls when clicking quickly
  const debouncedRange = useDebounce(selectedRange, 150);
  const timeRange = STATISTICS_TIME_RANGES[debouncedRange].hours;
  const timeRangeMinutes = timeRange * 60;
  
  // Always fetch at fixed spike window resolution (W = 10s)
  // This ensures "17% spike" means the same thing in 1H and 7D views
  const bucketCount = Math.ceil((timeRangeMinutes * 60) / SPIKE_WINDOW_SECONDS);

  useEffect(() => {
    async function fetchData() {
      setError(null);
      try {
        const [bucketedRes, packetTypeRes, noiseFloorRes] = await Promise.all([
          api.getBucketedStats(timeRangeMinutes, bucketCount),
          api.getPacketTypeGraphData(timeRange),
          api.getNoiseFloorHistory(timeRange),
        ]);

        if (bucketedRes.success && bucketedRes.data) {
          setRawBucketedStats(bucketedRes.data);
        }
        if (packetTypeRes.success && packetTypeRes.data) {
          setPacketTypeData(packetTypeRes.data);
        }
        if (noiseFloorRes.success && noiseFloorRes.data?.history) {
          setNoiseFloorHistory(noiseFloorRes.data.history);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load chart data');
      } finally {
        setInitialLoading(false);
      }
    }

    fetchData();
  }, [timeRange, timeRangeMinutes, bucketCount]);
  
  // Compute utilization points with spike-preserving rollup
  const utilizationData = useMemo((): UtilizationPoint[] => {
    if (!rawBucketedStats) return [];
    
    const { received, transmitted, forwarded, bucket_duration_seconds, start_time, end_time } = rawBucketedStats;
    const baseBucketMs = bucket_duration_seconds * 1000;
    
    // Combine TX sources
    const txBuckets = combineTxBuckets(transmitted, forwarded);
    
    // Time-based rollup preserving spikes
    return rollupSpikePreserving(
      received, 
      txBuckets, 
      baseBucketMs, 
      start_time, 
      end_time, 
      MAX_DISPLAY_POINTS
    );
  }, [rawBucketedStats]);

  // Poll utilization only, with intervals by range:
  // default 5m; 3d → 10m; 7d → 30m
  const utilizationPollMs = useMemo(() => {
    switch (timeRange) {
      case 72: // 3d
        return 10 * 60 * 1000;
      case 168: // 7d
        return 30 * 60 * 1000;
      default:
        return 5 * 60 * 1000;
    }
  }, [timeRange]);

  // Poll bucketed stats
  const pollBucketed = useCallback(async () => {
    try {
      const res = await api.getBucketedStats(timeRangeMinutes, bucketCount);
      if (res.success && res.data) setRawBucketedStats(res.data);
    } catch {
      // ignore polling errors
    }
  }, [timeRangeMinutes, bucketCount]);

  // Poll packet type distribution
  const pollPacketTypes = useCallback(async () => {
    try {
      const res = await api.getPacketTypeGraphData(timeRange);
      if (res.success && res.data) setPacketTypeData(res.data);
    } catch {
      // ignore polling errors
    }
  }, [timeRange]);

  // Poll noise floor history
  const pollNoiseFloor = useCallback(async () => {
    try {
      const res = await api.getNoiseFloorHistory(timeRange);
      if (res.success && res.data?.history) setNoiseFloorHistory(res.data.history);
    } catch {
      // ignore polling errors
    }
  }, [timeRange]);

  // Start polling (skip initial since initial fetch already happened)
  usePolling(pollBucketed, utilizationPollMs, true, true);
  usePolling(pollPacketTypes, utilizationPollMs, true, true);
  usePolling(pollNoiseFloor, utilizationPollMs, true, true);

  // Aggregate series data for packet types - memoized
  const packetTypePieData = useMemo(() => {
    if (!packetTypeData || !packetTypeData.series) return [];
    return packetTypeData.series
      .map((s) => ({
        name: s.name,
        value: s.data.reduce((sum, point) => sum + (point[1] ?? 0), 0),
      }))
      .filter((item) => item.value > 0);
  }, [packetTypeData]);

  // Extract noise floor timestamps and values for heatmap
  const noiseFloorHeatmapData = useMemo(() => {
    if (noiseFloorHistory.length === 0) {
      return { timestamps: [], values: [] };
    }
    
    const timestamps = noiseFloorHistory.map(item => item.timestamp);
    const values = noiseFloorHistory.map(item => item.noise_floor_dbm);
    
    return { timestamps, values };
  }, [noiseFloorHistory]);

  const currentRange = STATISTICS_TIME_RANGES[selectedRange];
  
  // Calculate RX utilization stats from the utilization data
  const rxUtilStats = useMemo(() => {
    const validPoints = utilizationData.filter(p => p.rxAvg !== null);
    if (validPoints.length === 0) return { peak: 0, mean: 0 };
    
    // Peak = max of all rxPeak values (highest spike in any raw bucket)
    const peak = Math.max(...validPoints.map(p => p.rxPeak ?? 0));
    // Mean = average of rxAvg values (overall trend)
    const mean = validPoints.reduce((sum, p) => sum + (p.rxAvg ?? 0), 0) / validPoints.length;
    
    return { peak, mean };
  }, [utilizationData]);

  return (
    <div className="section-gap">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          <BarChart3 className="w-6 h-6 text-accent-primary flex-shrink-0" />
          Statistics
        </h1>
        <TimeRangeSelector
          ranges={STATISTICS_TIME_RANGES}
          selectedIndex={selectedRange}
          onSelect={setSelectedRange}
        />
      </div>

      {error && (
        <div className="glass-card p-4 border border-accent-red/50 bg-accent-red/10">
          <p className="text-accent-red">{error}</p>
        </div>
      )}

      {initialLoading ? (
        <div className="glass-card card-padding text-center">
          <div className="animate-pulse text-text-muted">Loading statistics...</div>
        </div>
      ) : (
        <>
          {/* Row: Traffic Flow (2/3) + Link Quality (1/3) */}
          <div className="grid-12">
            {/* Traffic Flow - Airtime Utilization Chart */}
            <div className="col-span-full lg:col-span-8 glass-card card-padding">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mb-4 sm:mb-6">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-accent-primary" />
                  <h2 className="type-subheading text-text-primary">Airtime Utilization</h2>
                </div>
                <div className="flex items-center gap-3 sm:gap-4 sm:ml-auto">
                  <span className="type-data-xs text-text-muted">
                    Peak <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.peak.toFixed(2)}%</span>
                  </span>
                  <span className="type-data-xs text-text-muted">
                    Mean <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.mean.toFixed(2)}%</span>
                  </span>
                  <span className="pill-tag">{currentRange.label}</span>
                </div>
              </div>
              {utilizationData.length > 0 ? (
                <TrafficStackedChart data={utilizationData} />
              ) : (
                <div className="h-80 flex items-center justify-center text-text-muted">
                  No traffic data available
                </div>
              )}
            </div>

            {/* Neighbor Link Quality Polar Chart */}
            <div className="col-span-full lg:col-span-4 glass-card card-padding">
              <div className="flex items-center gap-2 mb-4">
                <Compass className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">Link Quality</h2>
              </div>
              <NeighborPolarChart
                neighbors={stats?.neighbors ?? {}}
                localLat={stats?.config?.repeater?.latitude ?? 0}
                localLon={stats?.config?.repeater?.longitude ?? 0}
              />
            </div>
          </div>

          {/* Row: Network Composition + Packet Types + Noise Floor (3-up on desktop) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-6">
            {/* Network Composition - Node type distribution */}
            <div className="glass-card card-padding">
              <div className="flex items-center gap-2 mb-4">
                <Network className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">Network Composition</h2>
              </div>
              <NetworkCompositionChart neighbors={stats?.neighbors ?? {}} />
            </div>

            {/* Packet Types - Treemap Chart */}
            <div className="glass-card card-padding">
              <div className="flex items-center gap-2 mb-4">
                <PieChart className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">Packet Types</h2>
              </div>
              {packetTypePieData.length > 0 ? (
                <PacketTypesChart data={packetTypePieData} />
              ) : (
                <div className="h-44 flex items-center justify-center text-text-muted">
                  No packet type data available
                </div>
              )}
            </div>

            {/* Noise Floor Heatmap */}
            <div className="glass-card card-padding">
              <div className="flex items-center gap-2 mb-4">
                <Radio className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">RF Noise Floor</h2>
                <span className="type-data-xs text-text-muted ml-auto">dBm</span>
              </div>
              <NoiseFloorHeatmap
                timestamps={noiseFloorHeatmapData.timestamps}
                values={noiseFloorHeatmapData.values}
                height={176}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
