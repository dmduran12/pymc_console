'use client';

import { useEffect, useState, useCallback, memo } from 'react';
import { Cpu, HardDrive, Thermometer, Activity, RefreshCw } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import * as api from '@/lib/api';
import type { HardwareStats } from '@/types/api';
import clsx from 'clsx';
import { POLLING_INTERVALS } from '@/lib/constants';
import { useResourceHistory, useAddResourceDataPoint, type ResourceDataPoint } from '@/lib/stores/useStore';

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: 'primary' | 'secondary' | 'green' | 'red' | 'yellow';
}

const COLOR_CLASSES = {
  primary: 'bg-accent-tertiary',
  secondary: 'bg-accent-secondary',
  green: 'bg-accent-success',
  red: 'bg-accent-danger',
  yellow: 'bg-accent-secondary',
} as const;

/** Memoized progress bar - only re-renders when value changes */
const ProgressBar = memo(function ProgressBar({ value, max = 100, color = 'primary' }: ProgressBarProps) {
  const percentage = Math.min((value / max) * 100, 100);
  const baseColor = COLOR_CLASSES[color];

  // Determine color based on threshold
  const barColor = percentage > 90 ? 'bg-accent-danger' : percentage > 70 ? 'bg-accent-secondary' : baseColor;

  return (
    <div className="h-2.5 bg-white/10 rounded-full overflow-hidden">
      <div 
        className={clsx('h-full rounded-full', barColor)}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
});


/** Temperature thresholds in Celsius */
const TEMP_THRESHOLDS = {
  cold: 30,
  normal: 50,
  warm: 65,
  hot: 80,
  danger: 90,
};

/** Grafana-style bar gauge for temperature with gradient */
const TemperatureGauge = memo(function TemperatureGauge({ 
  value, 
  label,
  min = 20, 
  max = 100 
}: { 
  value: number; 
  label: string;
  min?: number; 
  max?: number;
}) {
  const percentage = Math.min(Math.max(((value - min) / (max - min)) * 100, 0), 100);
  
  // Determine status text and colors (matching the gradient thresholds)
  const getStatus = () => {
    if (value < TEMP_THRESHOLDS.cold) return { 
      text: 'Cool', 
      bg: 'bg-accent-tertiary/20', 
      text_color: 'text-accent-tertiary',
      border: 'border-accent-tertiary/30'
    };
    if (value < TEMP_THRESHOLDS.normal) return { 
      text: 'Normal', 
      bg: 'bg-accent-success/20', 
      text_color: 'text-accent-success',
      border: 'border-accent-success/30'
    };
    if (value < TEMP_THRESHOLDS.warm) return { 
      text: 'Warm', 
      bg: 'bg-accent-secondary/20', 
      text_color: 'text-accent-secondary',
      border: 'border-accent-secondary/30'
    };
    if (value < TEMP_THRESHOLDS.hot) return { 
      text: 'Hot', 
      bg: 'bg-orange-500/20', 
      text_color: 'text-orange-400',
      border: 'border-orange-500/30'
    };
    return { 
      text: 'DANGER', 
      bg: 'bg-accent-danger/20', 
      text_color: 'text-accent-danger',
      border: 'border-accent-danger/30'
    };
  };
  
  const status = getStatus();
  
  // Calculate threshold positions as percentages
  const range = max - min;
  const thresholdPositions = {
    cold: ((TEMP_THRESHOLDS.cold - min) / range) * 100,
    normal: ((TEMP_THRESHOLDS.normal - min) / range) * 100,
    warm: ((TEMP_THRESHOLDS.warm - min) / range) * 100,
    hot: ((TEMP_THRESHOLDS.hot - min) / range) * 100,
  };

  // Build gradient that shows colors ONLY up to current temperature
  // This creates the "reveal" effect - you only see colors you've reached
  const getBarGradient = () => {
    // Color stops at threshold positions (as % of full scale)
    const stops = [
      { pos: 0, color: 'var(--accent-tertiary)' },
      { pos: thresholdPositions.cold, color: 'var(--accent-tertiary)' },
      { pos: thresholdPositions.cold, color: 'var(--accent-success)' },
      { pos: thresholdPositions.normal, color: 'var(--accent-success)' },
      { pos: thresholdPositions.normal, color: 'var(--accent-secondary)' },
      { pos: thresholdPositions.warm, color: 'var(--accent-secondary)' },
      { pos: thresholdPositions.warm, color: '#f97316' },
      { pos: thresholdPositions.hot, color: '#f97316' },
      { pos: thresholdPositions.hot, color: 'var(--accent-danger)' },
      { pos: 100, color: 'var(--accent-danger)' },
    ];
    
    // Convert to gradient string - positions are relative to BAR width, not container
    // So we scale them: if bar is at 50%, a stop at 60% of scale becomes 120% of bar (not visible)
    const scaledStops = stops.map(s => {
      // Scale position relative to current bar width
      const scaledPos = percentage > 0 ? (s.pos / percentage) * 100 : 0;
      return `${s.color} ${Math.min(scaledPos, 100)}%`;
    });
    
    return `linear-gradient(to right, ${scaledStops.join(', ')})`;
  };

  // Dimmed background showing full scale
  const scaleGradient = `linear-gradient(to right,
    var(--accent-tertiary) 0%,
    var(--accent-tertiary) ${thresholdPositions.cold}%,
    var(--accent-success) ${thresholdPositions.cold}%,
    var(--accent-success) ${thresholdPositions.normal}%,
    var(--accent-secondary) ${thresholdPositions.normal}%,
    var(--accent-secondary) ${thresholdPositions.warm}%,
    #f97316 ${thresholdPositions.warm}%,
    #f97316 ${thresholdPositions.hot}%,
    var(--accent-danger) ${thresholdPositions.hot}%,
    var(--accent-danger) 100%
  )`;

  return (
    <div className="space-y-1">
      {/* Label row with status pill and temp */}
      <div className="flex justify-between items-center">
        <span className="text-xs text-text-muted uppercase tracking-wide">{label}</span>
        <div className="flex items-center gap-1.5">
          {/* Status pill - sized to match text height */}
          <span className={clsx(
            'px-1.5 text-[9px] font-semibold rounded-full border leading-[14px]',
            status.bg, status.text_color, status.border
          )}>
            {status.text}
          </span>
          {/* Temperature value - always white */}
          <span className="text-sm font-semibold tabular-nums text-text-primary">
            {value.toFixed(1)}°
          </span>
        </div>
      </div>
      
      {/* Compact bar gauge */}
      <div className="relative h-2.5 bg-white/5 rounded-full overflow-hidden">
        {/* Full gradient background (dimmed) */}
        <div 
          className="absolute inset-0 opacity-15 rounded-full"
          style={{ background: scaleGradient }}
        />
        
        {/* Active bar */}
        <div 
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-300 ease-out"
          style={{ 
            background: getBarGradient(),
            width: `${percentage}%`,
          }}
        />
        
        {/* Tick marks at thresholds */}
        <div className="absolute inset-0 flex items-center pointer-events-none">
          {[TEMP_THRESHOLDS.normal, TEMP_THRESHOLDS.warm, TEMP_THRESHOLDS.hot].map((threshold) => {
            const pos = ((threshold - min) / (max - min)) * 100;
            if (pos < 0 || pos > 100) return null;
            return (
              <div
                key={threshold}
                className="absolute w-px h-1.5 bg-white/20"
                style={{ left: `${pos}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});

// Chart colors
const CPU_COLOR = '#60A5FA'; // Blue
const MEMORY_COLOR = '#F9D26F'; // Amber/Yellow

// 20-minute window in milliseconds
const WINDOW_MS = 20 * 60 * 1000;
// Number of slots in the 20-minute window (at 3s polling = 400 slots)
const NUM_SLOTS = Math.floor(WINDOW_MS / POLLING_INTERVALS.system);

/** Custom legend component */
function ResourcesLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload) return null;
  return (
    <div className="flex items-center gap-4 justify-center text-xs font-mono">
      {payload.map((entry, i) => (
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

/** Custom tooltip for resources chart */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ResourcesTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
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
            {entry.value.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/** 
 * Build chart data array with fixed NUM_SLOTS positions.
 * Data is right-aligned (newest on right), with nulls padding the left.
 * This approach preserves data even after idle periods.
 */
function buildChartData(
  data: ResourceDataPoint[]
): Array<{ slot: number; time: string; cpu: number | null; memory: number | null }> {
  // Create fixed-size array with nulls
  const slots: Array<{ slot: number; time: string; cpu: number | null; memory: number | null }> = [];
  
  // Calculate how many empty slots to prepend (right-align the data)
  const emptySlots = Math.max(0, NUM_SLOTS - data.length);
  
  // Fill empty slots on the left with placeholder times
  const now = Date.now();
  const slotDuration = POLLING_INTERVALS.system;
  for (let i = 0; i < emptySlots; i++) {
    // Calculate what time this slot would represent if we had data
    const slotTime = now - (NUM_SLOTS - i) * slotDuration;
    const timeStr = new Date(slotTime).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    slots.push({ slot: i, time: timeStr, cpu: null, memory: null });
  }
  
  // Add actual data points (they go on the right side)
  const dataToShow = data.slice(-NUM_SLOTS); // Take most recent if somehow more than NUM_SLOTS
  for (let i = 0; i < dataToShow.length; i++) {
    const point = dataToShow[i];
    slots.push({
      slot: emptySlots + i,
      time: point.time.slice(0, 5), // HH:MM only for display
      cpu: point.cpu,
      memory: point.memory,
    });
  }
  
  return slots;
}

/** System Resources chart component */
const SystemResourcesChart = memo(function SystemResourcesChart({ 
  data,
}: { 
  data: ResourceDataPoint[];
}) {
  // Build chart data with fixed slots, data right-aligned
  const chartData = buildChartData(data);
  
  // Show X-axis ticks at 5-minute intervals (every ~100 slots at 3s polling)
  const tickInterval = Math.floor(NUM_SLOTS / 4);

  if (data.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-text-muted">
        Collecting data...
      </div>
    );
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CPU_COLOR} stopOpacity={0.4} />
              <stop offset="95%" stopColor={CPU_COLOR} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="memoryGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={MEMORY_COLOR} stopOpacity={0.4} />
              <stop offset="95%" stopColor={MEMORY_COLOR} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.06)"
            vertical={false}
          />
          <XAxis
            dataKey="time"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            dy={8}
            interval={tickInterval}
          />
          <YAxis
            domain={[0, 100]}
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
            dx={-4}
            width={40}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip content={<ResourcesTooltip />} />
          <Legend content={<ResourcesLegend />} />
          <Area
            type="stepAfter"
            dataKey="cpu"
            name="CPU"
            stroke={CPU_COLOR}
            strokeWidth={2}
            fill="url(#cpuGradient)"
            fillOpacity={0.85}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Area
            type="stepAfter"
            dataKey="memory"
            name="Memory"
            stroke={MEMORY_COLOR}
            strokeWidth={2}
            fill="url(#memoryGradient)"
            fillOpacity={0.85}
            isAnimationActive={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

export default function SystemStatsPage() {
  const [stats, setStats] = useState<HardwareStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  
  // Use global store for resource history (persists across page navigation)
  const resourceHistory = useResourceHistory();
  const addResourceDataPoint = useAddResourceDataPoint();

  // Memoized fetch function that also accumulates history
  const fetchStats = useCallback(async () => {
    try {
      const response = await api.getHardwareStats();
      if (response.success && response.data) {
        setStats(response.data);
        setError(null);
        
        // Add data point to global store (handles deduplication internally)
        addResourceDataPoint(
          response.data.cpu.usage_percent,
          response.data.memory.usage_percent,
          NUM_SLOTS
        );
      } else {
        setError(response.error || 'Failed to fetch hardware stats');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch hardware stats');
    }
  }, [addResourceDataPoint]);

  useEffect(() => {
    let mounted = true;
    let worker: Worker | null = null;
    
    const doFetch = async () => {
      if (mounted) {
        await fetchStats();
        if (mounted) setLoading(false);
      }
    };
    void doFetch();
    
    // Use Web Worker for background-resistant polling
    // Workers aren't throttled when the tab is in the background
    if (typeof Worker !== 'undefined') {
      const workerCode = `
        const interval = ${POLLING_INTERVALS.system};
        setInterval(() => postMessage('tick'), interval);
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = () => {
        if (mounted) void fetchStats();
      };
    } else {
      // Fallback for environments without Worker support
      const interval = setInterval(fetchStats, POLLING_INTERVALS.system);
      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }
    
    return () => {
      mounted = false;
      if (worker) {
        worker.terminate();
      }
    };
  }, [fetchStats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  };

  return (
    <div className="section-gap">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          <Cpu className="w-6 h-6 text-accent-primary flex-shrink-0" />
          System Stats
        </h1>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-bg-subtle hover:bg-bg-elevated rounded-lg transition-colors text-sm text-text-muted hover:text-text-primary self-start sm:self-auto"
        >
          <RefreshCw className={clsx('w-4 h-4', refreshing && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="glass-card p-4 border border-accent-danger/50 bg-accent-danger/10">
          <p className="text-accent-danger">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="glass-card p-12 text-center">
          <div className="animate-pulse text-text-muted">Loading system stats...</div>
        </div>
      ) : stats ? (
        <div className="grid-12">
          {/* System Resources - Full width time-series chart */}
          <div className="col-span-full glass-card card-padding">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent-tertiary/20 flex items-center justify-center">
                  <Activity className="w-5 h-5 text-accent-tertiary" />
                </div>
                <div>
                  <h2 className="text-base font-medium text-text-primary">System Resources</h2>
                  <p className="text-xs text-text-muted">20 minute rolling window</p>
                </div>
              </div>
              {/* Current values */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <span className="text-xs text-text-muted uppercase">CPU</span>
                  <div className="text-lg font-semibold tabular-nums" style={{ color: CPU_COLOR }}>
                    {stats.cpu.usage_percent.toFixed(0)}%
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-text-muted uppercase">MEM</span>
                  <div className="text-lg font-semibold tabular-nums" style={{ color: MEMORY_COLOR }}>
                    {stats.memory.usage_percent.toFixed(0)}%
                  </div>
                </div>
              </div>
            </div>
            <SystemResourcesChart data={resourceHistory} />
            {/* Summary stats below chart */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-border-subtle text-xs text-text-muted">
              <div className="flex items-center gap-4">
                <span>{stats.cpu.count} CPU cores</span>
                {stats.cpu.load_avg && (
                  <span className="tabular-nums">
                    Load: {stats.cpu.load_avg['1min'].toFixed(2)} / {stats.cpu.load_avg['5min'].toFixed(2)} / {stats.cpu.load_avg['15min'].toFixed(2)}
                  </span>
                )}
              </div>
              <span className="tabular-nums">
                {(stats.memory.used / (1024 * 1024)).toFixed(0)} / {(stats.memory.total / (1024 * 1024)).toFixed(0)} MB
              </span>
            </div>
          </div>

          {/* Disk Usage - 12 cols mobile, 6 cols md */}
          <div className="col-span-full md:col-span-6 glass-card card-padding">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-lg bg-accent-success/20 flex items-center justify-center">
                <HardDrive className="w-6 h-6 text-accent-success" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-text-primary">Disk Usage</h2>
                <p className="text-sm text-text-muted">Storage utilization</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">Usage</span>
                <span className="text-text-primary font-medium">{stats.disk.usage_percent.toFixed(1)}%</span>
              </div>
              <ProgressBar value={stats.disk.usage_percent} color="green" />
              <div className="flex justify-between text-sm mt-2">
                <span className="text-text-muted">
                  {(stats.disk.used / (1024 * 1024 * 1024)).toFixed(1)} GB used
                </span>
                <span className="text-text-muted">
                  {(stats.disk.total / (1024 * 1024 * 1024)).toFixed(1)} GB total
                </span>
              </div>
            </div>
          </div>

          {/* Temperature - 12 cols mobile, 6 cols md */}
          <div className="col-span-full md:col-span-6 glass-card card-padding">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-accent-secondary/20 flex items-center justify-center">
                <Thermometer className="w-5 h-5 text-accent-secondary" />
              </div>
              <div>
                <h2 className="text-base font-medium text-text-primary">Temperature</h2>
                <p className="text-xs text-text-muted">System sensors</p>
              </div>
            </div>
            {stats.temperatures && Object.keys(stats.temperatures).length > 0 ? (
              <div className="space-y-2.5">
                {/* Show CPU thermal as primary gauge */}
                {stats.temperatures.cpu_thermal !== undefined && (
                  <TemperatureGauge 
                    value={stats.temperatures.cpu_thermal} 
                    label="CPU" 
                    min={20} 
                    max={100} 
                  />
                )}
                {/* Show other temps */}
                {Object.entries(stats.temperatures)
                  .filter(([key]) => key !== 'cpu_thermal')
                  .slice(0, 3)
                  .map(([key, value]) => (
                    <TemperatureGauge
                      key={key}
                      value={value}
                      label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      min={20}
                      max={100}
                    />
                  ))
                }
              </div>
            ) : (
              <div className="flex items-center justify-center h-20 text-text-muted text-sm">
                <Activity className="w-4 h-4 mr-2" />
                No sensors available
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
