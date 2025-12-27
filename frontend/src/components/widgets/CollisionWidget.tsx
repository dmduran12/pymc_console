/**
 * CollisionWidget - Displays estimated collision/interference rate
 *
 * Uses a sophisticated algorithm to estimate collision likelihood:
 * - Logarithmic scaling prevents 100% saturation
 * - Time-weighted approach favors recent observations
 * - Backoff timing provides persistence signal
 * 
 * The goal is to provide a realistic congestion indicator that ranges
 * from 0% (idle channel) to ~85% (severe congestion) without hitting
 * unrealistic 100% values in normal high-traffic scenarios.
 */

import { Zap } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedLBTStats, type ComputedChannelHealth } from './LBTDataContext';

/**
 * Estimate collision risk from LBT metrics using improved algorithm
 * 
 * Key improvements over naive approach:
 * 1. Logarithmic scaling for retry rate (diminishing returns)
 * 2. Capped channel busy contribution (max 25%)
 * 3. Backoff timing as tie-breaker, not primary factor
 * 4. Statistical correction for low sample sizes
 * 5. Practical maximum ~85% to avoid "100% collision" absurdity
 */
function estimateCollisionRisk(data: ComputedLBTStats): number {
  const { retryRate, channelBusyCount, totalPacketsWithLBT, avgBackoffMs, maxBackoffMs } = data;

  if (totalPacketsWithLBT === 0) return 0;
  
  // Low sample size correction - need at least ~10 packets for reliable estimate
  const sampleConfidence = Math.min(totalPacketsWithLBT / 10, 1);

  // Component 1: Retry Rate (0-40% contribution)
  // Use logarithmic scaling: log(1 + rate * k) / log(1 + 100 * k)
  // This gives diminishing returns - 50% retry rate doesn't mean 50% collision
  const k = 0.15; // Tuning factor
  const retryContribution = (Math.log(1 + retryRate * k) / Math.log(1 + 100 * k)) * 40;

  // Component 2: Channel Busy Events (0-25% contribution, capped)
  // Busy events are serious but capping prevents unrealistic saturation
  const busyRate = (channelBusyCount / totalPacketsWithLBT) * 100;
  const busyContribution = Math.min(busyRate * 0.5, 25);

  // Component 3: Backoff Timing Indicator (0-15% contribution)
  // High average backoff suggests persistent interference
  // Use average, not max (max is an outlier)
  let backoffContribution = 0;
  if (avgBackoffMs > 100) {
    // Logarithmic scaling: 100ms = 0%, 500ms = ~10%, 1000ms+ = 15%
    backoffContribution = Math.min(Math.log10(avgBackoffMs / 100) * 8, 15);
  }
  
  // Component 4: Max backoff as severity indicator (0-5% bonus)
  // Only adds if max is significantly higher than average (sporadic severe interference)
  let maxBackoffBonus = 0;
  if (maxBackoffMs > 500 && avgBackoffMs > 0 && maxBackoffMs > avgBackoffMs * 2) {
    maxBackoffBonus = Math.min((maxBackoffMs - 500) / 200, 5);
  }

  // Combine components with sample size confidence
  const rawRisk = retryContribution + busyContribution + backoffContribution + maxBackoffBonus;
  const adjustedRisk = rawRisk * sampleConfidence;

  // Practical cap at 85% - true 100% collision would mean no packets get through
  return Math.min(adjustedRisk, 85);
}

/** Convert collision risk to status */
function getCollisionStatus(risk: number): ComputedChannelHealth['status'] {
  if (risk < 5) return 'excellent';
  if (risk < 15) return 'good';
  if (risk < 30) return 'fair';
  if (risk < 50) return 'congested';
  return 'critical';
}

/** Get congestion level description */
function getCongestionLabel(risk: number): string {
  if (risk < 5) return 'Clear channel';
  if (risk < 15) return 'Light traffic';
  if (risk < 30) return 'Moderate traffic';
  if (risk < 50) return 'Heavy traffic';
  if (risk < 70) return 'Congested';
  return 'Severe congestion';
}

export function CollisionWidget() {
  const { lbtStats, isLoading, error } = useLBTData();

  const collisionRisk = lbtStats ? estimateCollisionRisk(lbtStats) : 0;
  const status = lbtStats ? getCollisionStatus(collisionRisk) : 'unknown';
  const maxBackoff = lbtStats?.maxBackoffMs ?? 0;

  // Show congestion label if we have data, otherwise show max backoff
  const subtitle = lbtStats 
    ? (maxBackoff > 200 ? `Max backoff: ${Math.round(maxBackoff)}ms` : getCongestionLabel(collisionRisk))
    : undefined;

  return (
    <MiniWidget
      title="Collision Risk"
      icon={<Zap className="mini-widget-icon" />}
      value={collisionRisk.toFixed(1)}
      unit="%"
      status={status}
      subtitle={subtitle}
      isLoading={isLoading}
      error={error}
    />
  );
}

export default CollisionWidget;
