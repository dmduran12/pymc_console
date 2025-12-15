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

// Legend order: TX Util, RX Util, Received, Forwarded, Dropped
const LEGEND_ORDER = ['TX Util', 'RX Util', 'Received', 'Forwarded', 'Dropped'];

// Polynomial degree for trend fitting (higher = more flexible, lower = smoother)
const POLY_DEGREE = 4;

/** Fit a polynomial to data points and return smoothed values */
function polynomialFit(data: number[], degree: number): number[] {
  if (data.length === 0) return [];
  if (data.length <= degree) return [...data]; // Not enough points
  
  const n = data.length;
  const x = data.map((_, i) => i / (n - 1)); // Normalize x to [0, 1]
  const y = data;
  
  // Build Vandermonde matrix for least squares: X * coeffs = y
  // Using normal equations: (X^T * X) * coeffs = X^T * y
  const cols = degree + 1;
  
  // X^T * X matrix
  const XtX: number[][] = Array(cols).fill(0).map(() => Array(cols).fill(0));
  // X^T * y vector
  const Xty: number[] = Array(cols).fill(0);
  
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < cols; j++) {
      const xij = Math.pow(x[i], j);
      Xty[j] += xij * y[i];
      for (let k = 0; k < cols; k++) {
        XtX[j][k] += xij * Math.pow(x[i], k);
      }
    }
  }
  
  // Solve using Gaussian elimination
  const coeffs = solveLinearSystem(XtX, Xty);
  if (!coeffs) return [...data]; // Fallback if solve fails
  
  // Evaluate polynomial at each point
  return x.map(xi => {
    let val = 0;
    for (let j = 0; j < coeffs.length; j++) {
      val += coeffs[j] * Math.pow(xi, j);
    }
    return Math.max(0, val); // Clamp to non-negative
  });
}

/** Gaussian elimination to solve Ax = b */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]); // Augmented matrix
  
  // Forward elimination
  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
    
    if (Math.abs(aug[i][i]) < 1e-10) return null; // Singular
    
    for (let k = i + 1; k < n; k++) {
      const factor = aug[k][i] / aug[i][i];
      for (let j = i; j <= n; j++) {
        aug[k][j] -= factor * aug[i][j];
      }
    }
  }
  
  // Back substitution
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= aug[i][j] * x[j];
    }
    x[i] /= aug[i][i];
  }
  
  return x;
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
  const AIRTIME_TX_COLOR = chartColors.chart1; // Cyan/mint
  const AIRTIME_RX_COLOR = metricColors.dropped; // Red
  const RECEIVED_COLOR = metricColors.received; // Green
  const FORWARDED_COLOR = metricColors.forwarded; // Blue
  const DROPPED_COLOR = chartColors.chart5; // Theme accent
  // Transform bucket data for composite chart
  const chartData = useMemo(() => {
    if (!received || received.length === 0) return [];

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

    // First pass: collect raw utilization values
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
    
    // Apply polynomial fit smoothing to utilization values
    const txUtilValues = rawData.map(d => d.txUtil);
    const rxUtilValues = rawData.map(d => d.rxUtil);
    const smoothedTx = polynomialFit(txUtilValues, POLY_DEGREE);
    const smoothedRx = polynomialFit(rxUtilValues, POLY_DEGREE);
    
    // Return data with smoothed utilization
    return rawData.map((d, i) => ({
      ...d,
      txUtil: smoothedTx[i],
      rxUtil: smoothedRx[i],
    }));
  }, [received, forwarded, dropped, transmitted, utilizationBins, txUtilization, rxUtilization]);

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  // Custom tooltip for composite chart
  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (!active || !payload || payload.length === 0) return null;
    
    return (
      <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
        <div className="font-medium text-text-primary mb-1">{label}</div>
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-text-muted">{entry.name}:</span>
            <span className="text-text-primary tabular-nums">
              {entry.name.includes('Util') ? `${entry.value.toFixed(1)}%` : entry.value}
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
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
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
          {/* Right Y-axis for utilization % - auto-scale based on data */}
          <YAxis
            yAxisId="right"
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            dx={8}
            width={36}
            domain={[0, 'auto']}
            tickFormatter={(v) => `${v.toFixed(1)}%`}
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
          
          {/* Stepped lines for airtime utilization - rendered AFTER bars so they appear on top */}
          <Line
            yAxisId="right"
            type="natural"
            dataKey="txUtil"
            name="TX Util"
            stroke={AIRTIME_TX_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="right"
            type="natural"
            dataKey="rxUtil"
            name="RX Util"
            stroke={AIRTIME_RX_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export const TrafficStackedChart = memo(TrafficStackedChartComponent);
