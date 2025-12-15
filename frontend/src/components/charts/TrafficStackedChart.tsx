'use client';

import { memo, useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { BucketData, UtilizationBin } from '@/lib/api';
import { useChartColors, useMetricColors } from '@/lib/hooks/useThemeColors';

interface TrafficStackedChartProps {
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

// Legend order: RX Util, Received, Forwarded, Dropped
const LEGEND_ORDER = ['RX Util', 'Received', 'Forwarded', 'Dropped'];

// Simple moving average window (number of periods)
const SMA_WINDOW = 4;

/** Apply simple moving average - averages the previous N periods */
function simpleMovingAverage(data: number[], window: number): number[] {
  if (data.length === 0) return [];
  const result: number[] = [];
  
  for (let i = 0; i < data.length; i++) {
    // Average from (i - window + 1) to i, clamped to valid indices
    const start = Math.max(0, i - window + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) {
      sum += data[j];
    }
    result.push(sum / (i - start + 1));
  }
  return result;
}

// Custom legend component - left justified with specific order
function TrafficLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload) return null;
  
  // Sort by LEGEND_ORDER
  const sorted = [...payload].sort((a, b) => {
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
 * Stacked bar chart showing traffic flow with airtime utilization overlay
 * Left Y-axis: packet counts (bars)
 * Right Y-axis: airtime utilization % (stepped lines)
 * 
 * Utilization data now comes from backend /api/utilization endpoint with proper
 * LoRa airtime calculations. Falls back to estimation if utilizationBins not provided.
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
  const AIRTIME_RX_COLOR = 'rgba(255,255,255,0.9)'; // White for RX util line
  const RECEIVED_COLOR = metricColors.received; // Green
  const FORWARDED_COLOR = metricColors.forwarded; // Blue
  const DROPPED_COLOR = chartColors.chart5; // Theme accent
  
  // Transform bucket data for composite chart
  // RX utilization is scaled to correlate with packet counts on left Y-axis
  const { chartData, maxPackets } = useMemo(() => {
    if (!received || received.length === 0) return { chartData: [], maxPackets: 0 };

    // Build a lookup map from utilization bins by timestamp
    // Backend sends 't' as bin start timestamp in milliseconds
    const getUtilForTimestamp = (ts: number): { txUtil: number; rxUtil: number } => {
      if (!utilizationBins || utilizationBins.length === 0) {
        // Fallback to legacy estimation when no utilization data
        return { txUtil: 0, rxUtil: 0 };
      }
      
      // ts is in seconds, bins have 't' in milliseconds
      const tsMs = ts * 1000;
      
      // Find the utilization bin closest to this timestamp
      // Bins are sorted by time, find the one where our timestamp falls within
      let bestBin = null;
      let bestDiff = Infinity;
      for (const bin of utilizationBins) {
        const diff = Math.abs(bin.t - tsMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestBin = bin;
        }
      }
      
      if (bestBin && bestDiff < 120000) { // within 2 minutes
        return {
          txUtil: bestBin.tx_util_pct,
          rxUtil: bestBin.rx_util_decoded_pct,
        };
      }
      return { txUtil: 0, rxUtil: 0 };
    };

    // Legacy estimation fallback values
    const totalReceived = received.reduce((sum, b) => sum + b.count, 0);
    const totalTransmitted = transmitted?.reduce((sum, b) => sum + b.count, 0) ?? 
                             forwarded.reduce((sum, b) => sum + b.count, 0);

    // First pass: collect raw data
    const rawData = received.map((bucket, i) => {
      // 24-hour time format
      const time = new Date(bucket.start * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      
      // Get utilization from real API data or fall back to estimation
      let util = getUtilForTimestamp(bucket.start);
      
      // If no real data and we have fallback values, use legacy estimation
      if (util.txUtil === 0 && util.rxUtil === 0 && (txUtilization > 0 || rxUtilization > 0)) {
        const rxRatio = totalReceived > 0 ? bucket.count / totalReceived : 0;
        const txCount = transmitted?.[i]?.count ?? forwarded[i]?.count ?? 0;
        const txRatio = totalTransmitted > 0 ? txCount / totalTransmitted : 0;
        util = {
          txUtil: Math.min(100, txUtilization * txRatio * received.length),
          rxUtil: Math.min(100, rxUtilization * rxRatio * received.length),
        };
      }
      
      return {
        time,
        timestamp: bucket.start,
        received: bucket.count,
        forwarded: forwarded[i]?.count ?? 0,
        dropped: dropped[i]?.count ?? 0,
        txUtil: util.txUtil,
        rxUtil: util.rxUtil,
      };
    });
    
    // Apply simple moving average to smooth utilization lines
    const txUtilValues = rawData.map(d => d.txUtil);
    const rxUtilValues = rawData.map(d => d.rxUtil);
    const smoothedTx = simpleMovingAverage(txUtilValues, SMA_WINDOW);
    const smoothedRx = simpleMovingAverage(rxUtilValues, SMA_WINDOW);
    
    // Calculate max stacked packet count and max RX util for scaling
    const maxStackedPackets = Math.max(...rawData.map(d => d.received + d.forwarded + d.dropped));
    const maxRxUtil = Math.max(...smoothedRx, 1); // min 1 to avoid div by zero
    
    // Scale factor: maps RX util percentage to packet count domain
    // When RX util is at max, the line should reach the top of the packet bars
    const scaleFactor = maxStackedPackets / maxRxUtil;
    
    const data = rawData.map((d, i) => ({
      ...d,
      txUtil: smoothedTx[i],
      rxUtil: smoothedRx[i],
      // Scaled version for plotting on left Y-axis
      rxUtilScaled: smoothedRx[i] * scaleFactor,
    }));
    
    return { chartData: data, maxPackets: maxStackedPackets };
  }, [received, forwarded, dropped, transmitted, utilizationBins, txUtilization, rxUtilization]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  // Custom tooltip for composite chart
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) => {
    if (!active || !payload || payload.length === 0) return null;
    
    return (
      <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
        <div className="font-medium text-text-primary mb-1">{label}</div>
        {payload.map((entry, i) => {
          // For RX Util, show the original percentage from payload data
          const isRxUtil = entry.dataKey === 'rxUtilScaled';
          const displayValue = isRxUtil 
            ? `${entry.payload.rxUtil.toFixed(1)}%`
            : entry.name.includes('Util') 
              ? `${entry.value.toFixed(1)}%` 
              : entry.value;
          
          return (
            <div key={i} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-text-muted">{entry.name}:</span>
              <span className="text-text-primary tabular-nums">
                {displayValue}
              </span>
            </div>
          );
        })}
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
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
            dy={8}
            interval="preserveStartEnd"
          />
          {/* Left Y-axis for packet counts (RX util is scaled to this axis) */}
          <YAxis
            yAxisId="left"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            dx={-8}
            width={32}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend content={<TrafficLegend />} />
          
          {/* Stacked stepped areas for traffic - purples/blues so util lines pop */}
          <Area
            yAxisId="left"
            type="stepAfter"
            dataKey="dropped"
            name="Dropped"
            stackId="traffic"
            fill={DROPPED_COLOR}
            stroke="none"
            fillOpacity={0.85}
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
            fillOpacity={0.85}
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
            fillOpacity={0.85}
            isAnimationActive={false}
          />
          
          {/* RX Utilization line - scaled to left axis (correlates with packets) */}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="rxUtilScaled"
            name="RX Util"
            stroke={AIRTIME_RX_COLOR}
            strokeWidth={3}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export const TrafficStackedChart = memo(TrafficStackedChartComponent);
