/**
 * TxDelayCard - Local TX delay recommendations using MeshCore slot-based system
 * 
 * MeshCore Formula: t(txdelay) = trunc(Af * 5 * txdelay)
 * - Af = 1.0 (airtime factor)
 * - Increments <0.2s have NO EFFECT (slot quantization)
 * - All outputs aligned to 0.2s boundaries
 */

import { useMemo } from 'react';
import { Timer, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { Stats } from '@/types/api';
import type { BucketData } from '@/lib/api';
import {
  DEFAULT_FLOOD_DELAY_SEC,
  DIRECT_TO_FLOOD_RATIO,
  alignToSlotBoundary,
  calculateSlots,
} from '@/lib/meshcore-tx-constants';

export interface TxDelayCardProps {
  stats: Stats | null;
  /** Historical received packets by bucket */
  receivedBuckets?: BucketData[];
  /** Historical dropped packets by bucket */
  droppedBuckets?: BucketData[];
  /** Historical forwarded packets by bucket */
  forwardedBuckets?: BucketData[];
  /** Bucket duration in seconds */
  bucketDurationSeconds?: number;
  /** Time range label (e.g., "20m", "1h") */
  timeRangeLabel?: string;
}

interface TxDelayResult {
  // MeshCore-aligned outputs (aligned to 0.2s)
  floodDelaySec: number;
  directDelaySec: number;
  floodSlots: number;
  directSlots: number;
  // Adjustment direction compared to current config
  adjustment: 'increase' | 'decrease' | 'stable';
  // Analysis inputs
  duplicateRate: number;
  txUtilization: number;
  zeroHopCount: number;
  totalReceived: number;
  totalDropped: number;
}

/**
 * Calculate recommended TX delay using MeshCore's slot-based system.
 * 
 * Key insight: txdelay increments <0.2s have NO EFFECT due to MeshCore's
 * truncation formula. We align all outputs to 0.2s boundaries.
 * 
 * Based on local node metrics:
 * - Higher duplicate rate => increase slots
 * - Higher TX utilization => increase slots  
 * - More zero-hop neighbors => increase slots (busier local area)
 */
function calculateTxDelays(
  stats: Stats | null,
  receivedBuckets?: BucketData[],
  droppedBuckets?: BucketData[],
  forwardedBuckets?: BucketData[],
  bucketDurationSeconds?: number,
): TxDelayResult {
  // Sum up historical data from buckets
  const totalReceived = receivedBuckets?.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const totalDropped = droppedBuckets?.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const totalForwarded = forwardedBuckets?.reduce((sum, b) => sum + b.count, 0) ?? 0;
  
  // Use bucket data if available, otherwise fall back to stats
  const rxCount = totalReceived > 0 ? totalReceived : (stats?.rx_count || 1);
  const droppedCount = totalDropped > 0 ? totalDropped : (stats?.dropped_count || 0);
  
  // Estimate duplicate rate from dropped packets (most drops are duplicates)
  const duplicateRate = rxCount > 0 ? (droppedCount / (rxCount + droppedCount)) * 100 : 0;
  
  // TX utilization calculation
  let txUtilization = 0;
  if (forwardedBuckets && forwardedBuckets.length > 0 && bucketDurationSeconds) {
    const avgAirtimeMs = 100; // ~100ms average for SF8/125kHz
    const totalTxAirtimeMs = totalForwarded * avgAirtimeMs;
    const totalTimeMs = forwardedBuckets.length * bucketDurationSeconds * 1000;
    txUtilization = (totalTxAirtimeMs / totalTimeMs) * 100;
  } else if (stats) {
    const uptimeMs = (stats.uptime_seconds || 1) * 1000;
    const airtimeUsedMs = stats.total_airtime_ms || stats.airtime_used_ms || 0;
    txUtilization = (airtimeUsedMs / uptimeMs) * 100;
  }
  
  // Count zero-hop neighbors (direct RF links)
  const neighbors = stats?.neighbors || {};
  const zeroHopCount = Object.values(neighbors).filter(n => n.zero_hop === true).length;
  
  // === SLOT-BASED CALCULATION ===
  // Start with MeshCore default (0.7s = 3 slots)
  let rawDelay = DEFAULT_FLOOD_DELAY_SEC;
  
  // Adjust based on duplicate rate (target: 5-8%)
  // Each adjustment is at least 0.2s (1 slot) to have effect
  if (duplicateRate < 3) {
    rawDelay -= 0.2;  // -1 slot: low duplicates, can be more aggressive
  } else if (duplicateRate > 15) {
    rawDelay += 0.4;  // +2 slots: high duplicates, need more backoff
  } else if (duplicateRate > 10) {
    rawDelay += 0.2;  // +1 slot: moderate duplicates
  }
  
  // Adjust based on TX utilization
  if (txUtilization > 5) {
    rawDelay += 0.2;  // +1 slot: high utilization
  }
  // Note: <5% utilization doesn't warrant adjustment (below slot resolution)
  
  // Adjust based on zero-hop neighbors (local RF density)
  if (zeroHopCount > 10) {
    rawDelay += 0.2;  // +1 slot: very busy local area
  } else if (zeroHopCount > 5) {
    // 5-10 neighbors: borderline, only add if we're at a slot boundary already
    // This prevents unnecessary rounding up
  }
  
  // Align to slot boundary and clamp
  const floodDelaySec = alignToSlotBoundary(rawDelay);
  
  // Direct delay using MeshCore's ratio (~28%)
  const directDelaySec = alignToSlotBoundary(floodDelaySec * DIRECT_TO_FLOOD_RATIO);
  
  // Calculate slot counts
  const floodSlots = calculateSlots(floodDelaySec);
  const directSlots = calculateSlots(directDelaySec);
  
  // Determine adjustment direction vs current config
  const currentDelay = stats?.config?.delays?.tx_delay_factor ?? DEFAULT_FLOOD_DELAY_SEC;
  const currentSlots = calculateSlots(currentDelay);
  let adjustment: 'increase' | 'decrease' | 'stable';
  if (floodSlots > currentSlots) {
    adjustment = 'increase';
  } else if (floodSlots < currentSlots) {
    adjustment = 'decrease';
  } else {
    adjustment = 'stable';
  }
  
  return {
    floodDelaySec,
    directDelaySec,
    floodSlots,
    directSlots,
    adjustment,
    duplicateRate: Math.round(duplicateRate * 100) / 100,
    txUtilization: Math.round(txUtilization * 1000) / 1000,
    zeroHopCount,
    totalReceived,
    totalDropped,
  };
}

export function TxDelayCard({ 
  stats, 
  receivedBuckets,
  droppedBuckets,
  forwardedBuckets,
  bucketDurationSeconds,
  timeRangeLabel,
}: TxDelayCardProps) {
  const calc = useMemo(
    () => calculateTxDelays(stats, receivedBuckets, droppedBuckets, forwardedBuckets, bucketDurationSeconds),
    [stats, receivedBuckets, droppedBuckets, forwardedBuckets, bucketDurationSeconds]
  );
  
  // Get current config values for comparison
  const currentTxDelay = stats?.config?.delays?.tx_delay_factor ?? null;
  const currentDirectDelay = stats?.config?.delays?.direct_tx_delay_factor ?? null;
  const currentFloodSlots = currentTxDelay !== null ? calculateSlots(currentTxDelay) : null;
  
  // Compare slot counts (not raw values - changes <0.2s don't matter)
  const hasSlotDiff = currentFloodSlots !== null && calc.floodSlots !== currentFloodSlots;
  
  // Get adjustment icon
  const AdjustIcon = calc.adjustment === 'increase' ? TrendingUp 
    : calc.adjustment === 'decrease' ? TrendingDown 
    : Minus;

  return (
    <div className="data-card flex flex-col min-h-[180px]">
      {/* Top section: Icon + Title + Time Range */}
      <div className="flex items-center gap-2 mb-3">
        <Timer className="w-4 h-4 text-[var(--metric-transmitted)]" />
        <span className="data-card-title">TX DELAY</span>
        {timeRangeLabel && (
          <span className="pill-tag">{timeRangeLabel}</span>
        )}
        {hasSlotDiff && (
          <span className={`pill-tag flex items-center gap-1 ${
            calc.adjustment === 'increase' 
              ? 'bg-accent-warning/20 text-accent-warning border-accent-warning/30'
              : 'bg-accent-success/20 text-accent-success border-accent-success/30'
          }`}>
            <AdjustIcon className="w-3 h-3" />
            {calc.adjustment === 'increase' ? '+' : '-'}
            {Math.abs(calc.floodSlots - (currentFloodSlots ?? 0))} slot{Math.abs(calc.floodSlots - (currentFloodSlots ?? 0)) !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      
      {/* Main recommendation values with slot counts */}
      <div className="flex items-baseline gap-4">
        <div>
          <div className="type-data-lg tabular-nums text-[var(--metric-transmitted)]">
            {calc.floodDelaySec.toFixed(1)}s
          </div>
          <div className="type-data-xs text-text-muted">
            tx_delay <span className="text-accent-secondary font-semibold">({calc.floodSlots} slots)</span>
          </div>
        </div>
        <div>
          <div className="type-data-lg tabular-nums text-[var(--metric-forwarded)]">
            {calc.directDelaySec.toFixed(1)}s
          </div>
          <div className="type-data-xs text-text-muted">
            direct <span className="text-accent-secondary font-semibold">({calc.directSlots} slots)</span>
          </div>
        </div>
      </div>
      
      {/* Diagnostics */}
      <div className="flex-1 mt-4 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-text-muted">Dup Rate</span>
          <span className={`tabular-nums ${calc.duplicateRate > 10 ? 'text-accent-warning' : 'text-text-secondary'}`}>
            {calc.duplicateRate.toFixed(1)}%
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-text-muted">TX Util</span>
          <span className="tabular-nums text-text-secondary">
            {calc.txUtilization.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-text-muted">Zero-hop</span>
          <span className="tabular-nums text-text-secondary">
            {calc.zeroHopCount}
          </span>
        </div>
      </div>
      
      {/* Current config comparison with slot counts */}
      <div className="data-card-secondary border-t border-border-subtle pt-3 mt-2">
        {currentTxDelay !== null ? (
          <span>
            Current: {currentTxDelay.toFixed(1)}s ({currentFloodSlots} slots) / {currentDirectDelay?.toFixed(1) ?? '—'}s
          </span>
        ) : (
          <span>Recommended delays (MeshCore slot-aligned)</span>
        )}
      </div>
    </div>
  );
}
