'use client';

import { useMemo } from 'react';
import { Timer } from 'lucide-react';
import type { Stats } from '@/types/api';
import type { BucketData } from '@/lib/api';

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

/**
 * Calculate recommended TX delay factors based on historical packet data.
 * 
 * Based on the txdelay.py calculator logic:
 * - Higher duplicate rate => increase tx_delay_factor
 * - Higher TX utilization => increase tx_delay_factor
 * - More zero-hop neighbors => can use lower delays
 */
function calculateTxDelays(
  stats: Stats | null,
  receivedBuckets?: BucketData[],
  droppedBuckets?: BucketData[],
  forwardedBuckets?: BucketData[],
  bucketDurationSeconds?: number,
): {
  txDelayFactor: number;
  directTxDelayFactor: number;
  duplicateRate: number;
  txUtilization: number;
  zeroHopCount: number;
  totalReceived: number;
  totalDropped: number;
} {
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
  // If we have bucket data, calculate from forwarded packets and time range
  let txUtilization = 0;
  if (forwardedBuckets && forwardedBuckets.length > 0 && bucketDurationSeconds) {
    // Estimate airtime per packet (~100ms average for SF8/125kHz)
    const avgAirtimeMs = 100;
    const totalTxAirtimeMs = totalForwarded * avgAirtimeMs;
    const totalTimeMs = forwardedBuckets.length * bucketDurationSeconds * 1000;
    txUtilization = (totalTxAirtimeMs / totalTimeMs) * 100;
  } else if (stats) {
    // Fallback to stats-based calculation
    const uptimeMs = (stats.uptime_seconds || 1) * 1000;
    const airtimeUsedMs = stats.total_airtime_ms || stats.airtime_used_ms || 0;
    txUtilization = (airtimeUsedMs / uptimeMs) * 100;
  }
  
  // Count zero-hop neighbors (direct links)
  const neighbors = stats?.neighbors || {};
  const zeroHopCount = Object.values(neighbors).filter(n => n.zero_hop === true).length;
  
  // Calculate recommended tx_delay_factor
  // Start with a base value and adjust based on metrics
  let txDelayFactor = 0.8; // Start conservative
  
  // Adjust based on duplicate rate
  // Target: 5-8% duplicate rate
  if (duplicateRate < 3) {
    txDelayFactor -= 0.1; // Can be more aggressive
  } else if (duplicateRate > 15) {
    txDelayFactor += 0.2;
  } else if (duplicateRate > 10) {
    txDelayFactor += 0.1; // Need more delay
  }
  
  // Adjust based on TX utilization
  // Higher utilization means we're busy, add delay
  if (txUtilization > 5) {
    txDelayFactor += 0.1;
  } else if (txUtilization > 1) {
    txDelayFactor += 0.05;
  }
  
  // Adjust based on zero-hop neighbors
  // More direct neighbors = busier local area, might need more delay
  if (zeroHopCount > 10) {
    txDelayFactor += 0.1;
  } else if (zeroHopCount > 5) {
    txDelayFactor += 0.05;
  }
  
  // Clamp to reasonable range
  txDelayFactor = Math.max(0.5, Math.min(1.5, txDelayFactor));
  
  // Direct TX delay is typically 30-50% of the flood delay
  // Lower because direct packets are targeted, less collision risk
  const directTxDelayFactor = txDelayFactor * 0.35;
  
  // Round to 2 decimal places
  txDelayFactor = Math.round(txDelayFactor * 100) / 100;
  const directRounded = Math.round(directTxDelayFactor * 100) / 100;
  
  return {
    txDelayFactor,
    directTxDelayFactor: directRounded,
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
  
  // Determine if recommendation differs significantly from current
  const txDiff = currentTxDelay !== null ? Math.abs(calc.txDelayFactor - currentTxDelay) : 0;
  const directDiff = currentDirectDelay !== null ? Math.abs(calc.directTxDelayFactor - currentDirectDelay) : 0;
  const hasSignificantDiff = txDiff > 0.1 || directDiff > 0.1;

  return (
    <div className="data-card flex flex-col min-h-[180px]">
      {/* Top section: Icon + Title + Time Range */}
      <div className="flex items-center gap-2 mb-3">
        <Timer className="w-4 h-4 text-[var(--metric-transmitted)]" />
        <span className="data-card-title">TX DELAY</span>
        {timeRangeLabel && (
          <span className="pill-tag">{timeRangeLabel}</span>
        )}
        {hasSignificantDiff && (
          <span className="pill-tag bg-accent-warning/20 text-accent-warning border-accent-warning/30">
            Adjust
          </span>
        )}
      </div>
      
      {/* Main recommendation values */}
      <div className="flex items-baseline gap-4">
        <div>
          <div className="type-data-lg tabular-nums text-[var(--metric-transmitted)]">
            {calc.txDelayFactor.toFixed(2)}
          </div>
          <div className="type-data-xs text-text-muted">tx_delay</div>
        </div>
        <div>
          <div className="type-data-lg tabular-nums text-[var(--metric-forwarded)]">
            {calc.directTxDelayFactor.toFixed(2)}
          </div>
          <div className="type-data-xs text-text-muted">direct_delay</div>
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
      
      {/* Current config comparison */}
      <div className="data-card-secondary border-t border-border-subtle pt-3 mt-2">
        {currentTxDelay !== null ? (
          <span>
            Current: {currentTxDelay.toFixed(2)} / {currentDirectDelay?.toFixed(2) ?? '—'}
          </span>
        ) : (
          <span>Recommended delays</span>
        )}
      </div>
    </div>
  );
}
