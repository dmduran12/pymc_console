/**
 * Airtime Utilization Chart
 * 
 * Displays TX/RX airtime utilization as clean line charts.
 * 
 * Accepts pre-computed UtilizationPoint[] data with proper time-weighted
 * utilization calculation: util% = Σairtime / Σinterval_duration × 100
 * 
 * null values represent gaps (no data) - shown as breaks in line.
 * 
 * Colors:
 * - RX Airtime: Green (#39D98A) - time spent receiving
 * - TX Airtime: Gray (#B0B0C3) - time spent transmitting
 * 
 * Y-axis: Fixed at 0-30% for consistent feel across time ranges
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
import type { UtilizationPoint } from '@/pages/Statistics';

// Fixed colors as per spec: RX = green, TX = gray
const RX_COLOR = '#39D98A'; // Green - semantic positive
const TX_COLOR = '#B0B0C3'; // Gray - neutral

// Fixed Y-axis domain for consistent feel across time ranges
const Y_AXIS_MAX = 30; // 30% - reasonable ceiling for LoRa mesh

export interface TrafficStackedChartProps {
  /** Pre-computed utilization points with proper time-weighted values */
  data: UtilizationPoint[];
  /** Optional fixed Y-axis max (default 30%) */
  yAxisMax?: number;
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
  payload?: Array<{ name: string; value: number | null; color: string }>; 
  label?: string 
}) {
  if (!active || !payload || payload.length === 0) return null;
  
  // Filter out null values (gaps)
  const validPayload = payload.filter(entry => entry.value !== null);
  if (validPayload.length === 0) return null;
  
  return (
    <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
      <div className="font-medium text-text-primary mb-1 font-mono">{label}</div>
      {validPayload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="w-3 h-0.5"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.name}:</span>
          <span className="text-text-primary tabular-nums font-mono">
            {entry.value!.toFixed(2)}%
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
 * Displays utilization with:
 * - Pre-computed time-weighted values (no internal calculation)
 * - null gaps shown as line breaks (connectNulls=false)
 * - Fixed Y-axis (0-30%) for consistent feel across zoom levels
 * - Monotone interpolation for smooth curves
 */
function TrafficStackedChartComponent({
  data,
  yAxisMax = Y_AXIS_MAX,
}: TrafficStackedChartProps) {
  // Calculate appropriate tick interval based on data points
  const tickInterval = useMemo(() => 
    Math.max(1, Math.floor(data.length / 10)), 
    [data.length]
  );

  if (data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data}>
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
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            domain={[0, yAxisMax]}
          />
          <Tooltip content={<UtilTooltip />} />
          <Legend content={<UtilLegend />} />
          
          {/* RX Utilization - Green */}
          <Line
            type="monotone"
            dataKey="rxUtil"
            name="RX Airtime"
            stroke={RX_COLOR}
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          
          {/* TX Utilization - Gray */}
          <Line
            type="monotone"
            dataKey="txUtil"
            name="TX Airtime"
            stroke={TX_COLOR}
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export const TrafficStackedChart = memo(TrafficStackedChartComponent);
