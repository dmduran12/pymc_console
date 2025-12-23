/**
 * Airtime Spectrogram Chart
 * 
 * True spectrogram visualization with:
 * - Layer 1 (Canvas): 2D intensity field with bilinear splat, blur, log compression
 * - Layer 2 (Recharts): Line chart showing avg trend + tooltip
 * 
 * The canvas layer shows utilization density over time (X=time, Y=util%, Color=energy),
 * while the Recharts layer provides interactivity and trend visualization.
 * 
 * This makes 1H and 7D views feel like the same instrument, just zoomed.
 */

import { memo, useRef, useEffect, useMemo } from 'react';
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
import type { UtilSample } from '@/lib/spectrum-utils';
import { drawSpectrogram } from '@/lib/spectrum-utils';

// Fixed colors as per spec: RX = green, TX = gray
const RX_COLOR = '#39D98A';
const TX_COLOR = '#B0B0C3';

// Fixed Y-axis domain for consistent feel across time ranges
const Y_AXIS_MAX = 30;

export interface AirtimeSpectrumChartProps {
  /** Fixed-window W samples (pre-computed) */
  samples: UtilSample[];
  /** Range start timestamp (seconds) */
  startTs: number;
  /** Range end timestamp (seconds) */
  endTs: number;
  /** Optional fixed Y-axis max (default 30%) */
  yMax?: number;
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
  label?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  
  const validPayload = payload.filter(entry => entry.value !== null && entry.value !== undefined);
  if (validPayload.length === 0) return null;
  
  // Format timestamp
  const time = label ? new Date(label * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) : '';
  
  return (
    <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm">
      <div className="font-medium text-text-primary mb-1 font-mono">{time}</div>
      {validPayload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="w-3 h-0.5"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-text-muted">{entry.name}:</span>
          <span className="text-text-primary tabular-nums font-mono">
            {Number(entry.value).toFixed(2)}%
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
 * Airtime Spectrum Analyzer Chart
 */
function AirtimeSpectrumChartComponent({
  samples,
  startTs,
  endTs,
  yMax = Y_AXIS_MAX,
}: AirtimeSpectrumChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Build lightweight line dataset (avg trend) at reasonable point count
  const trendData = useMemo(() => {
    const MAX = 400;
    if (samples.length === 0) return [];
    
    const step = Math.max(1, Math.floor(samples.length / MAX));
    const out: Array<{ timestamp: number; rx: number; tx: number }> = [];
    
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i];
      out.push({ timestamp: s.timestamp, rx: s.rxUtilW, tx: s.txUtilW });
    }
    
    return out;
  }, [samples]);

  // Calculate tick interval for X axis
  const tickInterval = useMemo(() => 
    Math.max(1, Math.floor(trendData.length / 8)), 
    [trendData.length]
  );

  // Format X axis tick
  const formatXTick = (ts: number): string => {
    const date = new Date(ts * 1000);
    const totalHours = (endTs - startTs) / 3600;
    
    if (totalHours > 24) {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
             ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // Draw spectrogram on canvas with ResizeObserver
  useEffect(() => {
    const el = wrapRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const redraw = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;

      // Set canvas size for high-DPI displays
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Draw true spectrogram with Gaussian splat, blur, log compression
      // Pass DPR so spectrogram renders at native resolution
      drawSpectrogram(ctx, samples, startTs, endTs, width, height, {
        yMax,
        gain: 12,
        gamma: 0.45,
        blurX: 12,      // Strong horizontal blur for persistence
        blurY: 6,       // Vertical blur for smooth bands
        splatRadius: 5, // Gaussian splat radius for smooth points
        dpr,
      });
    };

    const ro = new ResizeObserver(redraw);
    ro.observe(el);

    // Initial draw
    redraw();

    return () => ro.disconnect();
  }, [samples, startTs, endTs, yMax]);

  if (samples.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-text-muted">
        No traffic data available
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative h-80">
      {/* Canvas layer: spectrum analyzer (behind) */}
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 pointer-events-none" 
      />
      
      {/* Recharts layer: trend lines + tooltip (on top) */}
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={trendData}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.04)"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[startTs, endTs]}
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
            dy={8}
            interval={tickInterval}
            minTickGap={60}
            tickFormatter={formatXTick}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            dx={-8}
            width={44}
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            domain={[0, yMax]}
          />
          <Tooltip content={<UtilTooltip />} />
          <Legend content={<UtilLegend />} />
          
          {/* RX Average trend line */}
          <Line
            type="linear"
            dataKey="rx"
            name="RX Avg"
            stroke={RX_COLOR}
            strokeWidth={1.5}
            strokeOpacity={0.9}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          
          {/* TX Average trend line */}
          <Line
            type="linear"
            dataKey="tx"
            name="TX Avg"
            stroke={TX_COLOR}
            strokeWidth={1.5}
            strokeOpacity={0.8}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export const AirtimeSpectrumChart = memo(AirtimeSpectrumChartComponent);
