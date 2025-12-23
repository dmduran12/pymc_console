import { useEffect, useState, useMemo, useCallback } from 'react';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { useStats } from '@/lib/stores/useStore';
import { BarChart3, TrendingUp, PieChart, Radio, Compass, Network } from 'lucide-react';
import * as api from '@/lib/api';
import type { GraphData } from '@/types/api';
import type { BucketedStats, NoiseFloorHistoryItem } from '@/lib/api';
import { TimeRangeSelector } from '@/components/shared/TimeRangeSelector';
import { usePolling } from '@/lib/hooks/usePolling';
import { PacketTypesChart } from '@/components/charts/PacketTypesChart';
import { TrafficStackedChart } from '@/components/charts/TrafficStackedChart';
import { NeighborPolarChart } from '@/components/charts/NeighborPolarChart';
import { NoiseFloorHeatmap } from '@/components/charts/NoiseFloorHeatmap';
import { NetworkCompositionChart } from '@/components/charts/NetworkCompositionChart';
import { STATISTICS_TIME_RANGES } from '@/lib/constants';

export default function Statistics() {
  const stats = useStats();
  const [bucketedStats, setBucketedStats] = useState<BucketedStats | null>(null);
  const [packetTypeData, setPacketTypeData] = useState<GraphData | null>(null);
  const [noiseFloorHistory, setNoiseFloorHistory] = useState<NoiseFloorHistoryItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(3); // Default to 24h

  // Debounce time range changes to prevent rapid API calls when clicking quickly
  const debouncedRange = useDebounce(selectedRange, 150);
  const timeRange = STATISTICS_TIME_RANGES[debouncedRange].hours;
  const timeRangeMinutes = timeRange * 60;
  
  // Fixed 1440 data points for all time ranges (high resolution charts)
  // 1h  → 1440 buckets = 2.5s per bucket
  // 3h  → 1440 buckets = 7.5s per bucket
  // 12h → 1440 buckets = 30s per bucket
  // 24h → 1440 buckets = 1min per bucket
  // 3d  → 1440 buckets = 3min per bucket
  // 7d  → 1440 buckets = 7min per bucket
  const bucketCount = 1440;

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
          setBucketedStats(bucketedRes.data);
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

  // Poll bucketed stats (received/forwarded/dropped/transmitted)
  const pollBucketed = useCallback(async () => {
    try {
      const res = await api.getBucketedStats(timeRangeMinutes, bucketCount);
      if (res.success && res.data) setBucketedStats(res.data);
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
  
  // Calculate RX utilization stats from pre-computed airtime_ms in bucket data
  // getBucketedStats() now uses proper LoRa airtime formula (Semtech)
  const rxUtilStats = useMemo(() => {
    const received = bucketedStats?.received;
    const bucketDurationSeconds = bucketedStats?.bucket_duration_seconds ?? 0;
    
    if (!received || received.length === 0 || bucketDurationSeconds <= 0) {
      return { max: 0, mean: 0 };
    }
    
    const maxAirtimePerBucketMs = bucketDurationSeconds * 1000;
    
    // Calculate util for each bucket from pre-computed airtime_ms
    const utils = received.map(bucket => 
      (bucket.airtime_ms / maxAirtimePerBucketMs) * 100
    );
    
    const max = Math.max(...utils, 0);
    const mean = utils.length > 0 ? utils.reduce((a, b) => a + b, 0) / utils.length : 0;
    
    return { max, mean };
  }, [bucketedStats?.received, bucketedStats?.bucket_duration_seconds]);

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
                    RX Peak <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.max.toFixed(2)}%</span>
                  </span>
                  <span className="type-data-xs text-text-muted">
                    RX Avg <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.mean.toFixed(2)}%</span>
                  </span>
                  <span className="pill-tag">{currentRange.label}</span>
                </div>
              </div>
              {bucketedStats?.received && bucketedStats.received.length > 0 ? (
                <TrafficStackedChart
                  received={bucketedStats.received}
                  forwarded={bucketedStats.forwarded}
                  transmitted={bucketedStats.transmitted}
                  bucketDurationSeconds={bucketedStats.bucket_duration_seconds}
                />
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
