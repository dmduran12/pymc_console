import { useEffect, useState, useMemo, useCallback } from 'react';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { useStats } from '@/lib/stores/useStore';
import { BarChart3, TrendingUp, PieChart, Compass, Network, Radio } from 'lucide-react';
import * as api from '@/lib/api';
import type { GraphData } from '@/types/api';
import type { BucketedStats, NoiseFloorHistoryItem } from '@/lib/api';
import { TimeRangeSelector } from '@/components/shared/TimeRangeSelector';
import { usePolling } from '@/lib/hooks/usePolling';
import { PacketTypesChart } from '@/components/charts/PacketTypesChart';
import { AirtimeSpectrumChart } from '@/components/charts/AirtimeSpectrumChart';
import { NeighborPolarChart } from '@/components/charts/NeighborPolarChart';
import { NoiseFloorHeatmap } from '@/components/charts/NoiseFloorHeatmap';
import { NetworkCompositionChart } from '@/components/charts/NetworkCompositionChart';
import { STATISTICS_TIME_RANGES } from '@/lib/constants';
import { combineTxBuckets, toUtilSamples, type UtilSample } from '@/lib/spectrum-utils';
import { DisambiguationCard } from '@/components/stats/DisambiguationCard';

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
  
  // Compute utilization samples for spectrum analyzer
  const { utilSamples, startTs, endTs } = useMemo((): { utilSamples: UtilSample[]; startTs: number; endTs: number } => {
    if (!rawBucketedStats) return { utilSamples: [], startTs: 0, endTs: 0 };
    
    const { received, transmitted, forwarded, bucket_duration_seconds, start_time, end_time } = rawBucketedStats;
    const windowMs = bucket_duration_seconds * 1000;
    
    // Combine TX sources (transmitted + forwarded)
    const txBuckets = combineTxBuckets(transmitted, forwarded);
    
    // Convert to fixed-window utilization samples
    const samples = toUtilSamples(received, txBuckets, windowMs);
    
    return { utilSamples: samples, startTs: start_time, endTs: end_time };
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
  
  // Calculate RX utilization stats from the utilization samples
  const rxUtilStats = useMemo(() => {
    if (utilSamples.length === 0) return { peak: 0, mean: 0 };
    
    // Peak = max of all rxUtilW values (highest spike in any W-second window)
    const peak = Math.max(...utilSamples.map(s => s.rxUtilW));
    // Mean = average of rxUtilW values (overall trend)
    const mean = utilSamples.reduce((sum, s) => sum + s.rxUtilW, 0) / utilSamples.length;
    
    return { peak, mean };
  }, [utilSamples]);

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
              <AirtimeSpectrumChart
                samples={utilSamples}
                startTs={startTs}
                endTs={endTs}
              />
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

            {/* Prefix Disambiguation Stats */}
            <DisambiguationCard />
          </div>
        </>
      )}
    </div>
  );
}
