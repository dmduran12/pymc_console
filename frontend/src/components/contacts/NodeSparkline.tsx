/**
 * NodeSparkline - 7-day activity sparkline for mesh nodes
 * 
 * Shows at-a-glance traffic trend for a node based on packet appearances.
 * Uses 6-hour buckets (28 data points for 7 days).
 * 
 * Data is pre-computed in a Web Worker (sparkline-service.ts) and stored
 * in Zustand (useSparklineStore.ts). This component just renders the cached data.
 */

import { ResponsiveContainer, LineChart, Line, Area, ComposedChart, Tooltip } from 'recharts';
import { useSparkline, useIsComputingSparklines, type SparklineDataPoint } from '@/lib/stores/useSparklineStore';

// Re-export type for consumers
export type { SparklineDataPoint };

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

// Color scale for activity health (CSS variable names)
const COLOR_CRITICAL = 'var(--signal-critical)';  // Red - no activity
const COLOR_POOR = 'var(--signal-poor)';          // Orange - very low
const COLOR_FAIR = 'var(--signal-fair)';          // Yellow - low
const COLOR_GOOD = 'var(--signal-good)';          // Green - normal
const COLOR_EXCELLENT = 'var(--signal-excellent)';// Bright green - high
const COLOR_LOADING = 'var(--text-muted)';        // Gray - loading state

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

export interface NodeSparklineProps {
  /** Full node hash */
  nodeHash: string;
  /** Width of the sparkline (default: 60px, or '100%' for full width) */
  width?: number | string;
  /** Height of the sparkline (default: 20px) */
  height?: number;
  /** Line color (default: health-based) */
  color?: string;
  /** Show filled area under the line */
  showArea?: boolean;
  /** Show tooltip on hover with daily data */
  showTooltip?: boolean;
  /** Custom class name */
  className?: string;
}

/**
 * Get health color based on recent activity.
 * Uses the last 4 buckets (24 hours) to determine current health.
 */
function getHealthColor(data: SparklineDataPoint[]): string {
  if (data.length === 0) return COLOR_CRITICAL;
  
  // Look at last 4 buckets (24 hours) for current health
  const recentBuckets = data.slice(-4);
  const recentTotal = recentBuckets.reduce((sum, d) => sum + d.count, 0);
  const recentAvg = recentTotal / recentBuckets.length;
  
  // Also calculate overall average for comparison
  const totalCount = data.reduce((sum, d) => sum + d.count, 0);
  const overallAvg = totalCount / data.length;
  
  // If recent activity is zero, it's critical
  if (recentTotal === 0) return COLOR_CRITICAL;
  
  // Compare recent to overall average
  if (overallAvg > 0) {
    const ratio = recentAvg / overallAvg;
    if (ratio >= 1.2) return COLOR_EXCELLENT;  // 20%+ above average
    if (ratio >= 0.8) return COLOR_GOOD;       // Within normal range
    if (ratio >= 0.4) return COLOR_FAIR;       // Below average
    if (ratio >= 0.1) return COLOR_POOR;       // Very low
    return COLOR_CRITICAL;                      // Almost nothing
  }
  
  // Fallback based on absolute recent count
  if (recentTotal >= 10) return COLOR_EXCELLENT;
  if (recentTotal >= 5) return COLOR_GOOD;
  if (recentTotal >= 2) return COLOR_FAIR;
  if (recentTotal >= 1) return COLOR_POOR;
  return COLOR_CRITICAL;
}

/**
 * Custom tooltip for sparkline hover
 */
function SparklineTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: SparklineDataPoint }> }) {
  if (!active || !payload || !payload.length) return null;
  
  const data = payload[0].payload;
  const date = new Date(data.timestamp);
  const dateStr = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
  
  return (
    <div className="bg-bg-surface/95 border border-border-subtle rounded px-1.5 py-0.5 text-[10px] shadow-lg">
      <span className="text-text-muted">{dateStr}</span>
      <span className="ml-1.5 font-semibold tabular-nums">{data.count}</span>
    </div>
  );
}

/**
 * Compact sparkline showing 7-day packet activity trend for a node.
 * Data is pre-computed by sparkline worker - this component just renders.
 * 
 * Color coding:
 * - Green: Normal/high activity
 * - Yellow: Below average activity  
 * - Orange: Very low activity
 * - Red: No recent activity (last 24h)
 * - Gray dashed: Loading/computing
 */
export function NodeSparkline({
  nodeHash,
  width = 60,
  height = 20,
  color,  // If not provided, will use health-based color
  showArea = true,
  showTooltip = false,
  className = '',
}: NodeSparklineProps) {
  // Get pre-computed sparkline data from store (instant, no computation)
  const data = useSparkline(nodeHash);
  const isComputing = useIsComputingSparklines();
  
  // Determine color based on health (or use provided color)
  const lineColor = color ?? (data.length > 0 ? getHealthColor(data) : COLOR_LOADING);
  
  // Style object handles both number and string widths
  const containerStyle = {
    width: typeof width === 'number' ? width : width,
    height,
  };
  
  // No data - render dashed line (gray if loading, red if critical)
  if (data.length < 2) {
    const svgWidth = typeof width === 'number' ? width : 60;
    const noDataColor = isComputing ? COLOR_LOADING : COLOR_CRITICAL;
    return (
      <div 
        className={`flex items-center justify-center ${className}`}
        style={{ ...containerStyle, color: noDataColor }}
      >
        <svg width="100%" height={height} viewBox={`0 0 ${svgWidth} ${height}`} preserveAspectRatio="none">
          <line 
            x1={4} 
            y1={height / 2} 
            x2={svgWidth - 4} 
            y2={height / 2} 
            stroke="currentColor" 
            strokeWidth={1.5} 
            strokeDasharray="3,2"
            className={isComputing ? 'animate-pulse' : ''}
          />
        </svg>
      </div>
    );
  }
  
  // Unique gradient ID for this instance
  const gradientId = `sparkline-gradient-${nodeHash.slice(-6)}`;
  
  return (
    <div className={className} style={containerStyle}>
      <ResponsiveContainer width="100%" height="100%">
        {showArea ? (
          <ComposedChart data={data} margin={{ top: 1, right: 1, bottom: 1, left: 1 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            {showTooltip && (
              <Tooltip 
                content={<SparklineTooltip />}
                cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1 }}
              />
            )}
            <Area
              type="monotone"
              dataKey="count"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke={lineColor}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        ) : (
          <LineChart data={data} margin={{ top: 1, right: 1, bottom: 1, left: 1 }}>
            {showTooltip && (
              <Tooltip 
                content={<SparklineTooltip />}
                cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="count"
              stroke={lineColor}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export default NodeSparkline;
