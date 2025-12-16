'use client';

import { memo, useMemo } from 'react';
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { BucketData, UtilizationBin } from '@/lib/api';
import { useChartColors, useMetricColors } from '@/lib/hooks/useThemeColors';

export interface TrafficStackedChartProps {
  received: BucketData[];
  forwarded: BucketData[];
  dropped: BucketData[];
  /** Bucket duration in seconds (from getBucketedStats) */
  bucketDurationSeconds?: number;
  /** Spreading factor from radio config */
  spreadingFactor?: number;
  /** Bandwidth in kHz from radio config */
  bandwidthKhz?: number;
}

// Legend order: Received, Forwarded, Dropped
const LEGEND_ORDER = ['Received', 'Forwarded', 'Dropped'];

// Default LoRa parameters
const DEFAULT_SF = 8;
const DEFAULT_BW_KHZ = 125;
const DEFAULT_PKT_LEN = 40; // Average packet length in bytes

/**
 * Estimate airtime for a packet based on LoRa parameters
 * Simplified calculation matching pyMC_Repeater/repeater/airtime.py
 */
function estimateAirtimeMs(payloadLen: number, sf: number, bwKhz: number): number {
  const symbolTime = Math.pow(2, sf) / bwKhz; // ms per symbol
  const preambleTime = 8 * symbolTime;
  const payloadSymbols = (payloadLen + 4.25) * 8;
  const payloadTime = payloadSymbols * symbolTime;
  return preambleTime + payloadTime;
}

// Custom legend component - left justified with specific order
function TrafficLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload) return null;
  
  // Sort by LEGEND_ORDER, filter to only include our traffic series
  const sorted = [...payload]
    .filter(p => LEGEND_ORDER.includes(p.value))
    .sort((a, b) => {
      const aIdx = LEGEND_ORDER.indexOf(a.value);
      const bIdx = LEGEND_ORDER.indexOf(b.value);
      return aIdx - bIdx;
    });
  
  return (
    <div className="flex items-center gap-4 justify-start pl-8 text-xs font-mono">
      {sorted.map((entry, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

// Custom tooltip - only show packet counts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrafficTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  
  // Filter to only traffic series
  const trafficEntries = payload.filter(p => LEGEND_ORDER.includes(p.name));
  
  return (
    <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
      <div className="font-medium text-text-primary mb-1">{label}</div>
      {trafficEntries.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.name}:</span>
          <span className="text-text-primary tabular-nums">
            {entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Stacked area chart showing traffic flow
 * Left Y-axis: packet counts (stacked areas)
 * Right Y-axis: RX airtime utilization % calculated from packet counts and radio config
 */
function TrafficStackedChartComponent({
  received,
  forwarded,
  dropped,
  bucketDurationSeconds = 60,
  spreadingFactor = DEFAULT_SF,
  bandwidthKhz = DEFAULT_BW_KHZ,
}: TrafficStackedChartProps) {
  // Theme-aware colors
  const chartColors = useChartColors();
  const metricColors = useMetricColors();
  
  // Derived colors from theme
  const RECEIVED_COLOR = metricColors.received; // Green
  const FORWARDED_COLOR = metricColors.forwarded; // Blue
  const DROPPED_COLOR = chartColors.chart5; // Theme accent
  
  // Calculate airtime per packet based on radio config
  const airtimePerPacketMs = useMemo(() => 
    estimateAirtimeMs(DEFAULT_PKT_LEN, spreadingFactor, bandwidthKhz),
    [spreadingFactor, bandwidthKhz]
  );
  
  // Max possible airtime per bucket in ms
  const maxAirtimePerBucketMs = bucketDurationSeconds * 1000;
  
  // Transform bucket data for chart with RX util calculation
  // Always calculate from packet counts for accuracy
  const { chartData, maxRxUtil } = useMemo(() => {
    if (!received || received.length === 0 || maxAirtimePerBucketMs <= 0) {
      return { chartData: [], maxRxUtil: 0 };
    }

    let maxRxUtilRaw = 0;
    
    const rawData = received.map((bucket, i) => {
      const time = new Date(bucket.start * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      
      // Calculate RX utilization from packet count and radio parameters
      // RX airtime = packets * airtime_per_packet
      // Utilization % = (RX airtime / bucket duration) * 100
      const rxPackets = bucket.count;
      const rxAirtimeMs = rxPackets * airtimePerPacketMs;
      const rxUtil = (rxAirtimeMs / maxAirtimePerBucketMs) * 100;
      
      if (rxUtil > maxRxUtilRaw) maxRxUtilRaw = rxUtil;
      
      return {
        time,
        received: bucket.count,
        forwarded: forwarded[i]?.count ?? 0,
        dropped: dropped[i]?.count ?? 0,
        rxUtil,
      };
    });
    
    return { chartData: rawData, maxRxUtil: maxRxUtilRaw };
  }, [received, forwarded, dropped, airtimePerPacketMs, maxAirtimePerBucketMs]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chartData}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.06)"
            vertical={false}
          />
          <XAxis
            dataKey="time"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            dy={8}
            interval="preserveStartEnd"
          />
          {/* Left Y-axis for packet counts */}
          <YAxis
            yAxisId="left"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            dx={-8}
            width={32}
          />
          {/* Right Y-axis for RX utilization % - scaled so max util aligns with max packet peaks */}
          <YAxis
            yAxisId="right"
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
            dx={8}
            width={44}
            domain={[0, maxRxUtil]}
            tickFormatter={(v) => `${v.toFixed(1)}%`}
          />
          <Tooltip content={<TrafficTooltip />} />
          <Legend content={<TrafficLegend />} />
          
          {/* Stacked stepped areas for traffic */}
          <Area
            yAxisId="left"
            type="stepAfter"
            dataKey="dropped"
            name="Dropped"
            stackId="traffic"
            fill={DROPPED_COLOR}
            stroke="none"
            fillOpacity={0.9}
            isAnimationActive={false}
          />
          <Area
            yAxisId="left"
            type="stepAfter"
            dataKey="forwarded"
            name="Forwarded"
            stackId="traffic"
            fill={FORWARDED_COLOR}
            stroke="none"
            fillOpacity={0.9}
            isAnimationActive={false}
          />
          <Area
            yAxisId="left"
            type="stepAfter"
            dataKey="received"
            name="Received"
            stackId="traffic"
            fill={RECEIVED_COLOR}
            stroke="none"
            fillOpacity={0.9}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export const TrafficStackedChart = memo(TrafficStackedChartComponent);

/** Result type for RX utilization stats */
export interface RxUtilStats {
  max: number;
  mean: number;
}

/**
 * Hook to calculate RX util stats from bucket data using radio config
 * Always calculates from packet counts for accuracy and consistency
 */
export function useRxUtilStats(
  _utilizationBins?: UtilizationBin[], // Kept for API compatibility but not used
  received?: BucketData[],
  bucketDurationSeconds = 60,
  spreadingFactor = DEFAULT_SF,
  bandwidthKhz = DEFAULT_BW_KHZ
): RxUtilStats {
  return useMemo(() => {
    // Calculate from received bucket data using radio config
    if (received && received.length > 0 && bucketDurationSeconds > 0) {
      const airtimePerPacketMs = estimateAirtimeMs(DEFAULT_PKT_LEN, spreadingFactor, bandwidthKhz);
      const maxAirtimePerBucketMs = bucketDurationSeconds * 1000;
      
      const utils = received.map(bucket => {
        const rxAirtimeMs = bucket.count * airtimePerPacketMs;
        return (rxAirtimeMs / maxAirtimePerBucketMs) * 100;
      });
      
      const max = Math.max(...utils, 0);
      const mean = utils.length > 0 ? utils.reduce((a, b) => a + b, 0) / utils.length : 0;
      return { max, mean };
    }
    
    return { max: 0, mean: 0 };
  }, [received, bucketDurationSeconds, spreadingFactor, bandwidthKhz]);
}
