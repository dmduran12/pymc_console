/**
 * Airtime Utilization Chart
 * 
 * Displays TX/RX airtime utilization as clean line charts.
 * 
 * Data source: BucketData from getBucketedStats() which includes pre-computed
 * airtime_ms using proper LoRa Semtech formula (see lib/airtime.ts).
 * 
 * Colors:
 * - RX Airtime: Green (#39D98A) - time spent receiving
 * - TX Airtime: Gray (#B0B0C3) - time spent transmitting
 * 
 * Y-axis: Dynamic range based on max utilization in data set
 */

import { memo, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { BucketData } from '@/lib/api';

// Fixed colors as per spec: RX = green, TX = gray
const RX_COLOR = '#39D98A'; // Green - semantic positive
const TX_COLOR = '#B0B0C3'; // Gray - neutral

export interface TrafficStackedChartProps {
  received: BucketData[];
  forwarded: BucketData[];
  transmitted?: BucketData[];
  /** 
   * Duration of the RAW bucket (before downsampling) in seconds.
   * Used to calculate utilization percentage correctly.
   * After downsampling, airtime_ms represents MAX from any raw bucket,
   * so we must calculate util as: airtime_ms / (rawBucketDurationSeconds * 1000)
   */
  rawBucketDurationSeconds?: number;
  /** Display bucket duration (for time axis formatting) */
  displayBucketDurationSeconds?: number;
}

/**
 * Custom tooltip for chart hover
 */
function UtilTooltip({ 
  active, 
  payload, 
  label 
}: { 
  active?: boolean; 
  payload?: Array<{ name: string; value: number; color: string }>; 
  label?: string 
}) {
  if (!active || !payload || payload.length === 0) return null;
  
  return (
    <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
      <div className="font-medium text-text-primary mb-1 font-mono">{label}</div>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="w-3 h-0.5"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.name}:</span>
          <span className="text-text-primary tabular-nums font-mono">
            {entry.value.toFixed(3)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Custom legend component
 */
function UtilLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload) return null;
  
  return (
    <div className="flex items-center gap-6 justify-center text-xs font-mono">
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="w-4 h-0.5"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Airtime Utilization Line Chart
 * 
 * Displays peak utilization from downsampled bucket data.
 * airtime_ms in each bucket represents the MAX from the underlying raw buckets,
 * so utilization is calculated against the RAW bucket duration (typically 5 seconds).
 * 
 * Y-axis dynamically scales based on max value in dataset.
 */
function TrafficStackedChartComponent({
  received,
  forwarded,
  transmitted,
  rawBucketDurationSeconds = 5,
  displayBucketDurationSeconds = 60,
}: TrafficStackedChartProps) {
  // Utilization is calculated against the RAW bucket duration
  // because airtime_ms represents the MAX from any raw bucket, not a sum
  const maxAirtimePerRawBucketMs = rawBucketDurationSeconds * 1000;
  
  // Transform bucket data for chart with TX/RX util calculation
  const chartData = useMemo(() => {
    if (!received || received.length === 0 || maxAirtimePerRawBucketMs <= 0) {
      return [];
    }
    
    // Determine time format based on data span
    const totalMinutes = (received.length * displayBucketDurationSeconds) / 60;
    const showDate = totalMinutes > 1440; // More than 24 hours
    
    return received.map((bucket, i) => {
      const date = new Date(bucket.start * 1000);
      let time: string;
      
      if (showDate) {
        // For multi-day ranges, show date + time
        time = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + 
               ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      } else {
        time = date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      }
      
      // RX utilization: MAX airtime from any raw bucket / raw bucket duration
      const rxUtil = (bucket.airtime_ms / maxAirtimePerRawBucketMs) * 100;
      
      // TX utilization: MAX of (transmitted + forwarded) airtime
      const txAirtimeMs = Math.max(
        transmitted?.[i]?.airtime_ms ?? 0,
        forwarded[i]?.airtime_ms ?? 0
      );
      const txUtil = (txAirtimeMs / maxAirtimePerRawBucketMs) * 100;
      
      return {
        time,
        rxUtil,
        txUtil,
      };
    });
  }, [received, forwarded, transmitted, maxAirtimePerRawBucketMs, displayBucketDurationSeconds]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }
  
  // Calculate appropriate tick interval based on data points
  // Aim for ~10-12 ticks on x-axis for 1440 data points
  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={chartData}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.06)"
            vertical={false}
          />
          <XAxis
            dataKey="time"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
            dy={8}
            interval={tickInterval}
            minTickGap={40}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            dx={-8}
            width={44}
            tickFormatter={(v) => `${v.toFixed(1)}%`}
            domain={[0, 'auto']}
          />
          <Tooltip content={<UtilTooltip />} />
          <Legend content={<UtilLegend />} />
          
          {/* RX Utilization - Green */}
          <Line
            type="linear"
            dataKey="rxUtil"
            name="RX Airtime"
            stroke={RX_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          
          {/* TX Utilization - Gray */}
          <Line
            type="linear"
            dataKey="txUtil"
            name="TX Airtime"
            stroke={TX_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export const TrafficStackedChart = memo(TrafficStackedChartComponent);
