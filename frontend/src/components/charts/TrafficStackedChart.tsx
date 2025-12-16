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
  transmitted?: BucketData[];
  /** Airtime utilization bins from /api/utilization */
  utilizationBins?: UtilizationBin[];
  /** Fallback: Current TX utilization percent (0-100) - used if utilizationBins not provided */
  txUtilization?: number;
  /** Fallback: Current RX utilization percent (0-100) - used if utilizationBins not provided */
  rxUtilization?: number;
}

// Legend order: Received, Forwarded, Dropped
const LEGEND_ORDER = ['Received', 'Forwarded', 'Dropped'];

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

/**
 * Stacked area chart showing traffic flow
 * Left Y-axis: packet counts (stacked areas)
 * Right Y-axis: RX airtime utilization % scaled to packet peaks
 * 
 * Returns maxRxUtil via the exported hook for display in parent header
 */
function TrafficStackedChartComponent({
  received,
  forwarded,
  dropped,
  transmitted,
  utilizationBins,
  txUtilization = 0,
  rxUtilization = 0,
}: TrafficStackedChartProps) {
  // Theme-aware colors
  const chartColors = useChartColors();
  const metricColors = useMetricColors();
  
  // Derived colors from theme
  const RECEIVED_COLOR = metricColors.received; // Green
  const FORWARDED_COLOR = metricColors.forwarded; // Blue
  const DROPPED_COLOR = chartColors.chart5; // Theme accent
  
  // Transform bucket data for chart
  // Right Y-axis shows RX util % scaled so max util aligns with max packet peaks
  const { chartData, maxRxUtil } = useMemo(() => {
    if (!received || received.length === 0) return { chartData: [], maxRxUtil: 0 };

    // Build a lookup map from utilization bins by timestamp
    const getUtilForTimestamp = (ts: number): { txUtil: number; rxUtil: number } => {
      if (!utilizationBins || utilizationBins.length === 0) {
        return { txUtil: 0, rxUtil: 0 };
      }
      
      const tsMs = ts * 1000;
      let bestBin = null;
      let bestDiff = Infinity;
      for (const bin of utilizationBins) {
        const diff = Math.abs(bin.t - tsMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestBin = bin;
        }
      }
      
      if (bestBin && bestDiff < 120000) {
        return {
          txUtil: bestBin.tx_util_pct,
          rxUtil: bestBin.rx_util_decoded_pct,
        };
      }
      return { txUtil: 0, rxUtil: 0 };
    };

    // Legacy estimation fallback
    const totalReceived = received.reduce((sum, b) => sum + b.count, 0);
    const totalTransmitted = transmitted?.reduce((sum, b) => sum + b.count, 0) ?? 
                             forwarded.reduce((sum, b) => sum + b.count, 0);

    // Collect raw data and track max RX util
    let maxRxUtilRaw = 0;
    const rawData = received.map((bucket, i) => {
      const time = new Date(bucket.start * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      
      let util = getUtilForTimestamp(bucket.start);
      
      // Fallback estimation if no real data
      if (util.txUtil === 0 && util.rxUtil === 0 && (txUtilization > 0 || rxUtilization > 0)) {
        const rxRatio = totalReceived > 0 ? bucket.count / totalReceived : 0;
        const txCount = transmitted?.[i]?.count ?? forwarded[i]?.count ?? 0;
        const txRatio = totalTransmitted > 0 ? txCount / totalTransmitted : 0;
        util = {
          txUtil: Math.min(100, txUtilization * txRatio * received.length),
          rxUtil: Math.min(100, rxUtilization * rxRatio * received.length),
        };
      }
      
      if (util.rxUtil > maxRxUtilRaw) maxRxUtilRaw = util.rxUtil;
      
      return {
        time,
        received: bucket.count,
        forwarded: forwarded[i]?.count ?? 0,
        dropped: dropped[i]?.count ?? 0,
        rxUtil: util.rxUtil,
      };
    });
    
    // Max stacked packet count determines the scale relationship
    const maxStackedPackets = Math.max(...rawData.map(d => d.received + d.forwarded + d.dropped), 1);
    
    // Max RX util for the period (for display in header)
    const maxRxUtil = Math.max(maxRxUtilRaw, 0.1); // min 0.1 to avoid display issues
    
    return { chartData: rawData, maxRxUtil, maxStackedPackets };
  }, [received, forwarded, dropped, transmitted, utilizationBins, txUtilization, rxUtilization]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  // Custom tooltip - only show packet counts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) => {
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
  };

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
          <Tooltip content={<CustomTooltip />} />
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

/**
 * Hook to calculate max RX util for a given set of utilization bins
 * Use this in the parent component to display the max value in the header
 */
export function useMaxRxUtil(utilizationBins?: UtilizationBin[]): number {
  return useMemo(() => {
    if (!utilizationBins || utilizationBins.length === 0) return 0;
    return Math.max(...utilizationBins.map(b => b.rx_util_decoded_pct), 0);
  }, [utilizationBins]);
}
