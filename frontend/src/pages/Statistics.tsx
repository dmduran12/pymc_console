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
 * CANONICAL UTILIZATION DEFINITION:
 * 
 *   util% = (Σ airtime_ms in interval) / (interval_duration_ms) × 100
 * 
 * This is a time-weighted average that stays consistent across zoom levels.
 * 
 * Key principles:
 * 1. Sum airtime over the interval (not average of per-point percentages)
 * 2. Missing data = null (not 0) - prevents dragging down mean
 * 3. Weighted rollup: bucket_util = Σairtime / Σvalid_duration
 */

/** Max display points - rollup to this count */
const MAX_DISPLAY_POINTS = 720;

/** Bucket duration targets by time range for consistent feel */
const BUCKET_DURATIONS: Record<number, number> = {
  1: 5,      // 1H: 5s buckets (720 points)
  3: 15,    // 3H: 15s buckets (720 points)
  12: 60,   // 12H: 1m buckets (720 points)
  24: 120,  // 24H: 2m buckets (720 points)
  72: 360,  // 3D: 6m buckets (720 points)
  168: 840, // 7D: 14m buckets (720 points)
};

/**
 * Utilization point for chart display.
 * Includes both avg (main trend) and peak (spike indicator).
 * null values represent gaps (no data) - chart will break the line.
 */
export interface UtilizationPoint {
  time: string;
  timestamp: number;
  rxAvg: number | null;   // Average util over the display bucket
  rxPeak: number | null;  // Max util from any raw bucket in the slice
  txAvg: number | null;
  txPeak: number | null;
}

/**
 * Rollup buckets with avg + peak utilization.
 * 
 * For each output bucket:
 *   - avg: total airtime / total duration (time-weighted average)
 *   - peak: max utilization from any single raw bucket (spike indicator)
 * 
 * Buckets are DENSE (pre-initialized with zeros), so 0 = idle, not gap.
 */
function rollupToUtilization(
  rxBuckets: BucketData[],
  txBuckets: BucketData[],  // transmitted + forwarded combined
  rawBucketDurationMs: number,
  targetCount: number
): UtilizationPoint[] {
  if (rxBuckets.length === 0) return [];
  
  const ratio = Math.max(1, rxBuckets.length / targetCount);
  const result: UtilizationPoint[] = [];
  
  // Determine time format based on span
  const totalHours = (rxBuckets.length * rawBucketDurationMs) / (1000 * 60 * 60);
  const showDate = totalHours > 24;
  
  for (let i = 0; i < targetCount && i * ratio < rxBuckets.length; i++) {
    const startIdx = Math.floor(i * ratio);
    const endIdx = Math.min(Math.floor((i + 1) * ratio), rxBuckets.length);
    const rxSlice = rxBuckets.slice(startIdx, endIdx);
    const txSlice = txBuckets.slice(startIdx, endIdx);
    
    if (rxSlice.length === 0) continue;
    
    let rxAirtimeMs = 0;
    let txAirtimeMs = 0;
    let rxPeak = 0;
    let txPeak = 0;
    
    const sliceLen = rxSlice.length;
    const durationMs = sliceLen * rawBucketDurationMs;
    
    for (let j = 0; j < sliceLen; j++) {
      const r = rxSlice[j];
      const t = txSlice[j];
      
      // Sum airtime (buckets are dense, so always present)
      rxAirtimeMs += r?.airtime_ms ?? 0;
      txAirtimeMs += t?.airtime_ms ?? 0;
      
      // Track peak util from individual raw buckets
      const rUtil = r ? (r.airtime_ms / rawBucketDurationMs) * 100 : 0;
      const tUtil = t ? (t.airtime_ms / rawBucketDurationMs) * 100 : 0;
      
      if (rUtil > rxPeak) rxPeak = rUtil;
      if (tUtil > txPeak) txPeak = tUtil;
    }
    
    // Avg = total airtime / total duration
    const rxAvg = durationMs > 0 ? (rxAirtimeMs / durationMs) * 100 : null;
    const txAvg = durationMs > 0 ? (txAirtimeMs / durationMs) * 100 : null;
    
    // Format timestamp
    const date = new Date(rxSlice[0].start * 1000);
    let time: string;
    if (showDate) {
      time = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + 
             ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } else {
      time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    
    result.push({
      time,
      timestamp: rxSlice[0].start,
      rxAvg,
      rxPeak: durationMs > 0 ? rxPeak : null,
      txAvg,
      txPeak: durationMs > 0 ? txPeak : null,
    });
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

/**
 * Get optimal bucket duration for a time range.
 */
function getBucketDuration(hours: number): number {
  return BUCKET_DURATIONS[hours] ?? Math.ceil((hours * 3600) / MAX_DISPLAY_POINTS);
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
  
  // Get bucket duration for this time range
  const bucketDurationSeconds = getBucketDuration(timeRange);
  const bucketCount = Math.ceil((timeRangeMinutes * 60) / bucketDurationSeconds);

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
  
  // Compute utilization points with proper time-weighted rollup
  const utilizationData = useMemo((): UtilizationPoint[] => {
    if (!rawBucketedStats) return [];
    
    const { received, transmitted, forwarded, bucket_duration_seconds } = rawBucketedStats;
    const rawBucketDurationMs = bucket_duration_seconds * 1000;
    
    // Combine TX sources
    const txBuckets = combineTxBuckets(transmitted, forwarded);
    
    // Rollup to display points with proper weighted utilization
    return rollupToUtilization(received, txBuckets, rawBucketDurationMs, MAX_DISPLAY_POINTS);
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
