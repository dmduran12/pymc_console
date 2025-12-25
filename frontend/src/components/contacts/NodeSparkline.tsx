/**
 * NodeSparkline - 7-day activity sparkline for mesh nodes
 * 
 * Shows at-a-glance traffic trend for a node based on packet appearances.
 * Uses 6-hour buckets (28 data points for 7 days).
 * 
 * If less than 7 days of data, the chart starts from the earliest packet
 * and doesn't artificially fill the left side.
 */

import { useMemo } from 'react';
import { ResponsiveContainer, LineChart, Line, Area, ComposedChart, Tooltip } from 'recharts';
import { packetCache } from '@/lib/packet-cache';
import { usePacketCacheState } from '@/lib/stores/useStore';
import type { Packet } from '@/types/api';
import { getHashPrefix } from '@/lib/path-utils';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const BUCKET_HOURS = 6;  // 6-hour buckets
const MAX_BUCKETS = 28;  // 7 days = 28 buckets
const MS_PER_BUCKET = BUCKET_HOURS * 60 * 60 * 1000;

// Color scale for activity health (CSS variable names)
const COLOR_CRITICAL = 'var(--signal-critical)';  // Red - no activity
const COLOR_POOR = 'var(--signal-poor)';          // Orange - very low
const COLOR_FAIR = 'var(--signal-fair)';          // Yellow - low
const COLOR_GOOD = 'var(--signal-good)';          // Green - normal
const COLOR_EXCELLENT = 'var(--signal-excellent)';// Bright green - high

// ═══════════════════════════════════════════════════════════════════════════════
// Data Computation
// ═══════════════════════════════════════════════════════════════════════════════

export interface SparklineDataPoint {
  /** Bucket index (0 = oldest) */
  idx: number;
  /** Packet count in this bucket */
  count: number;
  /** Timestamp of bucket start */
  timestamp: number;
}

/**
 * Compute sparkline data for a node from cached packets.
 * 
 * Counts ALL packets where the node is involved:
 * - Is the source (src_hash matches)
 * - Is the destination (dest_hash matches)  
 * - Is in the forwarding path (original_path or forwarded_path)
 * - Was the last hop (direct RF contact indicator)
 * 
 * @param nodeHash - Full hash of the node (e.g., "0x19ABCDEF")
 * @param packets - Array of packets to analyze
 * @returns Array of data points for the sparkline
 */
export function computeNodeSparkline(
  nodeHash: string,
  packets: Packet[]
): SparklineDataPoint[] {
  if (!nodeHash || packets.length === 0) return [];
  
  const prefix = getHashPrefix(nodeHash);
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  // Initialize buckets
  const buckets = new Map<number, number>();
  
  // Track earliest packet timestamp to avoid filling empty left side
  let earliestPacketTs = now;
  let hasAnyData = false;
  
  for (const packet of packets) {
    const ts = packet.timestamp * 1000; // Convert to ms if needed
    const normalizedTs = ts > 1e12 ? ts : ts * 1000; // Handle both ms and seconds
    
    // Skip packets older than 7 days
    if (normalizedTs < sevenDaysAgo) continue;
    
    // Check if this node is involved in the packet
    let isInvolved = false;
    
    // Check source hash
    if (!isInvolved && packet.src_hash) {
      const srcPrefix = getHashPrefix(packet.src_hash);
      if (srcPrefix === prefix) isInvolved = true;
    }
    
    // Check destination hash
    if (!isInvolved && packet.dst_hash) {
      const destPrefix = getHashPrefix(packet.dst_hash);
      if (destPrefix === prefix) isInvolved = true;
    }
    
    // Check original_path (forwarding chain)
    if (!isInvolved && packet.original_path) {
      for (const hop of packet.original_path) {
        if (hop.toUpperCase() === prefix) {
          isInvolved = true;
          break;
        }
      }
    }
    
    // Check forwarded_path
    if (!isInvolved && packet.forwarded_path) {
      for (const hop of packet.forwarded_path) {
        if (hop.toUpperCase() === prefix) {
          isInvolved = true;
          break;
        }
      }
    }
    
    // Check path_hash (may indicate involvement)
    if (!isInvolved && packet.path_hash) {
      const pathPrefix = getHashPrefix(packet.path_hash);
      if (pathPrefix === prefix) isInvolved = true;
    }
    
    if (isInvolved) {
      hasAnyData = true;
      earliestPacketTs = Math.min(earliestPacketTs, normalizedTs);
      
      // Calculate bucket index from the start of 7-day window
      const bucketIdx = Math.floor((normalizedTs - sevenDaysAgo) / MS_PER_BUCKET);
      const clampedIdx = Math.max(0, Math.min(MAX_BUCKETS - 1, bucketIdx));
      
      buckets.set(clampedIdx, (buckets.get(clampedIdx) || 0) + 1);
    }
  }
  
  if (!hasAnyData) return [];
  
  // Determine the starting bucket (don't fill empty left side)
  const startBucketIdx = Math.max(0, Math.floor((earliestPacketTs - sevenDaysAgo) / MS_PER_BUCKET));
  
  // Build result array from first data to now
  const result: SparklineDataPoint[] = [];
  for (let i = startBucketIdx; i < MAX_BUCKETS; i++) {
    result.push({
      idx: i - startBucketIdx,  // Normalize to 0-based
      count: buckets.get(i) || 0,
      timestamp: sevenDaysAgo + (i * MS_PER_BUCKET),
    });
  }
  
  return result;
}

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
 * Automatically fetches data from the packet cache.
 * 
 * Color coding:
 * - Green: Normal/high activity
 * - Yellow: Below average activity  
 * - Orange: Very low activity
 * - Red: No recent activity (last 24h)
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
  // Subscribe to cache state to trigger re-render when packets load
  const cacheState = usePacketCacheState();
  
  // Get packets from cache and compute sparkline data
  // Re-compute when packet count changes (background/deep load completion)
  const data = useMemo(() => {
    const packets = packetCache.getPackets();
    return computeNodeSparkline(nodeHash, packets);
  }, [nodeHash, cacheState.packetCount]);
  
  // Determine color based on health (or use provided color)
  const lineColor = color ?? getHealthColor(data);
  
  // Style object handles both number and string widths
  const containerStyle = {
    width: typeof width === 'number' ? width : width,
    height,
  };
  
  // No data - render red dashed line (critical)
  if (data.length < 2) {
    const svgWidth = typeof width === 'number' ? width : 60;
    return (
      <div 
        className={`flex items-center justify-center ${className}`}
        style={{ ...containerStyle, color: COLOR_CRITICAL }}
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
