/**
 * Traffic Flow Chart - TX/RX Airtime Utilization
 * 
 * Displays airtime utilization as clean line charts:
 * - RX util: Green (semantic positive) - time spent receiving
 * - TX util: Neutral color - time spent transmitting
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
import { useMetricColors } from '@/lib/hooks/useThemeColors';

export interface TrafficStackedChartProps {
  received: BucketData[];
  forwarded: BucketData[];
  dropped: BucketData[];
  transmitted?: BucketData[];
  /** Bucket duration in seconds (from getBucketedStats) */
  bucketDurationSeconds?: number;
  /** Spreading factor from radio config */
  spreadingFactor?: number;
  /** Bandwidth in kHz from radio config */
  bandwidthKhz?: number;
}

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

// Custom legend component
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

// Custom tooltip
function UtilTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
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
            {entry.value.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Line chart showing TX and RX airtime utilization
 * Clean, non-smoothed lines without dots
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
  const metricColors = useMetricColors();
  
  // RX = semantic positive (green), TX = neutral
  const RX_COLOR = metricColors.received; // Green
  const TX_COLOR = metricColors.neutral;  // Neutral gray
  
  // Calculate airtime per packet based on radio config
  const airtimePerPacketMs = useMemo(() => 
    estimateAirtimeMs(DEFAULT_PKT_LEN, spreadingFactor, bandwidthKhz),
    [spreadingFactor, bandwidthKhz]
  );
  
  // Max possible airtime per bucket in ms
  const maxAirtimePerBucketMs = bucketDurationSeconds * 1000;
  
  // Transform bucket data for chart with TX/RX util calculation
  const chartData = useMemo(() => {
    if (!received || received.length === 0 || maxAirtimePerBucketMs <= 0) {
      return [];
    }
    
    // Determine time format based on data density
    const totalMinutes = (received.length * bucketDurationSeconds) / 60;
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
      
      // RX utilization: received packets * airtime / bucket duration
      const rxPackets = bucket.count;
      const rxAirtimeMs = rxPackets * airtimePerPacketMs;
      const rxUtil = (rxAirtimeMs / maxAirtimePerBucketMs) * 100;
      
      // TX utilization: forwarded + dropped (all transmitted packets)
      // Note: forwarded = packets we forwarded, which requires TX
      const txPackets = (forwarded[i]?.count ?? 0) + (dropped[i]?.count ?? 0);
      const txAirtimeMs = txPackets * airtimePerPacketMs;
      const txUtil = (txAirtimeMs / maxAirtimePerBucketMs) * 100;
      
      return {
        time,
        rxUtil,
        txUtil,
      };
    });
  }, [received, forwarded, dropped, airtimePerPacketMs, maxAirtimePerBucketMs, bucketDurationSeconds]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }
  
  // Calculate appropriate tick interval based on data points
  // Aim for ~8-12 ticks on x-axis
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
          
          {/* RX Utilization - Green (positive semantic) */}
          <Line
            type="linear"
            dataKey="rxUtil"
            name="RX Airtime"
            stroke={RX_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          
          {/* TX Utilization - Neutral */}
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
  _utilizationBins?: unknown[], // Kept for API compatibility but not used
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
