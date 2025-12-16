'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { useStats } from '@/lib/stores/useStore';
import { BarChart3, TrendingUp, PieChart, Radio, Compass } from 'lucide-react';
import * as api from '@/lib/api';
import type { GraphData } from '@/types/api';
import type { BucketedStats, UtilizationStats, NoiseFloorHistoryItem } from '@/lib/api';
import { TimeRangeSelector } from '@/components/shared/TimeRangeSelector';
import { usePolling } from '@/lib/hooks/usePolling';
import { PacketTypesChart } from '@/components/charts/PacketTypesChart';
import { TrafficStackedChart } from '@/components/charts/TrafficStackedChart';
import { NeighborPolarChart } from '@/components/charts/NeighborPolarChart';
import { NoiseFloorHeatmap } from '@/components/charts/NoiseFloorHeatmap';
import { STATISTICS_TIME_RANGES } from '@/lib/constants';

export default function StatisticsPage() {
  const stats = useStats();
  const [bucketedStats, setBucketedStats] = useState<BucketedStats | null>(null);
  const [utilizationStats, setUtilizationStats] = useState<UtilizationStats | null>(null);
  const [packetTypeData, setPacketTypeData] = useState<GraphData | null>(null);
  const [noiseFloorHistory, setNoiseFloorHistory] = useState<NoiseFloorHistoryItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
const [selectedRange, setSelectedRange] = useState(1); // Default to 3h

  // Debounce time range changes to prevent rapid API calls when clicking quickly
  const debouncedRange = useDebounce(selectedRange, 150);
  const timeRange = STATISTICS_TIME_RANGES[debouncedRange].hours;
  const timeRangeMinutes = timeRange * 60;

  useEffect(() => {
    async function fetchData() {
      setError(null);
      try {
        // Calculate bucket count based on time range (aim for ~60 buckets)
        const bucketCount = Math.min(120, Math.max(30, Math.floor(timeRangeMinutes / 2)));
        
        const [bucketedRes, utilizationRes, packetTypeRes, noiseFloorRes] = await Promise.all([
          api.getBucketedStats(timeRangeMinutes, bucketCount),
          api.getUtilizationStats(timeRange),
          api.getPacketTypeGraphData(timeRange),
          api.getNoiseFloorHistory(timeRange),
        ]);

        if (bucketedRes.success && bucketedRes.data) {
          setBucketedStats(bucketedRes.data);
        }
        if (utilizationRes.success && utilizationRes.data) {
          setUtilizationStats(utilizationRes.data);
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
  }, [timeRange, timeRangeMinutes]);

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

  const pollUtilization = useCallback(async () => {
    try {
      const res = await api.getUtilizationStats(timeRange);
      if (res.success && res.data) setUtilizationStats(res.data);
    } catch (_) {
      // ignore polling errors
    }
  }, [timeRange]);

  // Derive common chart polling interval using same cadence
  const chartPollMs = utilizationPollMs;

  // Poll bucketed stats (received/forwarded/dropped/transmitted)
  const pollBucketed = useCallback(async () => {
    try {
      const bucketCount = Math.min(120, Math.max(30, Math.floor(timeRangeMinutes / 2)));
      const res = await api.getBucketedStats(timeRangeMinutes, bucketCount);
      if (res.success && res.data) setBucketedStats(res.data);
    } catch (_) {
      // ignore polling errors
    }
  }, [timeRangeMinutes]);

  // Poll packet type distribution
  const pollPacketTypes = useCallback(async () => {
    try {
      const res = await api.getPacketTypeGraphData(timeRange);
      if (res.success && res.data) setPacketTypeData(res.data);
    } catch (_) {
      // ignore polling errors
    }
  }, [timeRange]);

  // Poll noise floor history
  const pollNoiseFloor = useCallback(async () => {
    try {
      const res = await api.getNoiseFloorHistory(timeRange);
      if (res.success && res.data?.history) setNoiseFloorHistory(res.data.history);
    } catch (_) {
      // ignore polling errors
    }
  }, [timeRange]);

  // Start polling (skip initial since initial fetch already happened)
  usePolling(pollUtilization, chartPollMs, true, true);
  usePolling(pollBucketed, chartPollMs, true, true);
  usePolling(pollPacketTypes, chartPollMs, true, true);
  usePolling(pollNoiseFloor, chartPollMs, true, true);

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
  
  // Get radio config for utilization calculation
  const spreadingFactor = stats?.config?.radio?.spreading_factor ?? 8;
  // API returns bandwidth in Hz (e.g., 125000), convert to kHz for airtime calc
  const bandwidthHz = stats?.config?.radio?.bandwidth ?? 125000;
  const bandwidthKhz = bandwidthHz >= 1000 ? bandwidthHz / 1000 : bandwidthHz;
  
  // Calculate RX util stats directly from bucket data
  const rxUtilStats = useMemo(() => {
    const received = bucketedStats?.received;
    const bucketDurationSeconds = bucketedStats?.bucket_duration_seconds ?? 0;
    
    // DEBUG: Log all inputs
    console.log('[RxUtil Debug]', {
      hasReceived: !!received,
      receivedLength: received?.length,
      bucketDurationSeconds,
      spreadingFactor,
      bandwidthKhz,
      firstBucketCount: received?.[0]?.count,
      sampleCounts: received?.slice(0, 5).map(b => b.count),
    });
    
    if (!received || received.length === 0 || bucketDurationSeconds <= 0) {
      console.log('[RxUtil Debug] Early return - missing data');
      return { max: 0, mean: 0 };
    }
    
    // Calculate airtime per packet based on radio config
    // Simplified formula matching pyMC_Repeater/repeater/airtime.py
    const pktLen = 40; // Average packet length
    const symbolTime = Math.pow(2, spreadingFactor) / bandwidthKhz; // ms
    const preambleTime = 8 * symbolTime;
    const payloadSymbols = (pktLen + 4.25) * 8;
    const payloadTime = payloadSymbols * symbolTime;
    const airtimePerPacketMs = preambleTime + payloadTime;
    
    const maxAirtimePerBucketMs = bucketDurationSeconds * 1000;
    
    // Calculate util for each bucket
    const utils = received.map(bucket => {
      const rxAirtimeMs = bucket.count * airtimePerPacketMs;
      return (rxAirtimeMs / maxAirtimePerBucketMs) * 100;
    });
    
    const max = Math.max(...utils, 0);
    const mean = utils.reduce((a, b) => a + b, 0) / utils.length;
    
    console.log('[RxUtil Debug] Calculated:', {
      airtimePerPacketMs,
      maxAirtimePerBucketMs,
      sampleUtils: utils.slice(0, 5),
      max,
      mean,
    });
    
    return { max, mean };
  }, [bucketedStats?.received, bucketedStats?.bucket_duration_seconds, spreadingFactor, bandwidthKhz]);

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
            {/* Traffic Flow - Stacked Area Chart */}
            <div className="col-span-full lg:col-span-8 glass-card card-padding">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">Traffic Flow</h2>
                <div className="ml-auto flex items-center gap-4">
                  <span className="type-data-xs text-text-muted">
                    Max <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.max.toFixed(1)}%</span>
                  </span>
                  <span className="type-data-xs text-text-muted">
                    Mean <span className="text-text-secondary tabular-nums font-medium">{rxUtilStats.mean.toFixed(1)}%</span>
                  </span>
                  <span className="pill-tag">{currentRange.label}</span>
                </div>
              </div>
              {bucketedStats?.received && bucketedStats.received.length > 0 ? (
                <TrafficStackedChart
                  received={bucketedStats.received}
                  forwarded={bucketedStats.forwarded}
                  dropped={bucketedStats.dropped}
                  bucketDurationSeconds={bucketedStats.bucket_duration_seconds}
                  spreadingFactor={spreadingFactor}
                  bandwidthKhz={bandwidthKhz}
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

          {/* Row: Packet Types + Noise Floor */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-6">
            {/* Packet Types - Horizontal Bar Chart */}
            <div className="glass-card card-padding">
              <div className="flex items-center gap-2 mb-6">
                <PieChart className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">Packet Types</h2>
              </div>
              {packetTypePieData.length > 0 ? (
                <PacketTypesChart data={packetTypePieData} />
              ) : (
                <div className="h-56 flex items-center justify-center text-text-muted">
                  No packet type data available
                </div>
              )}
            </div>

            {/* Noise Floor Heatmap */}
            <div className="glass-card card-padding">
              <div className="flex items-center gap-2 mb-6">
                <Radio className="w-5 h-5 text-accent-primary" />
                <h2 className="type-subheading text-text-primary">RF Noise Floor</h2>
                <span className="type-data-xs text-text-muted ml-auto">dBm</span>
              </div>
              <NoiseFloorHeatmap
                timestamps={noiseFloorHeatmapData.timestamps}
                values={noiseFloorHeatmapData.values}
                height={224}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
