/**
 * CollisionWidget - Displays estimated collision/interference rate
 *
 * Estimates packet collision likelihood based on LBT retry patterns
 * and channel busy events. Higher values indicate more interference.
 */

import { Zap } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedLBTStats, type ComputedChannelHealth } from './LBTDataContext';

/**
 * Estimate collision risk from LBT metrics
 * This combines retry rate with channel busy events to estimate interference
 */
function estimateCollisionRisk(data: ComputedLBTStats): number {
  const { retryRate, channelBusyCount, totalPacketsWithLBT, maxBackoffMs } = data;

  if (totalPacketsWithLBT === 0) return 0;

  // Base collision estimate from retry rate (retries indicate activity when trying to TX)
  let risk = retryRate * 0.5;

  // Channel busy events are strong collision indicators
  const busyRate = (channelBusyCount / totalPacketsWithLBT) * 100;
  risk += busyRate * 2;

  // High max backoff indicates persistent interference
  if (maxBackoffMs > 500) {
    risk += Math.min((maxBackoffMs - 500) / 100, 10);
  }

  return Math.min(risk, 100);
}

/** Convert collision risk to status */
function getCollisionStatus(risk: number): ComputedChannelHealth['status'] {
  if (risk < 5) return 'excellent';
  if (risk < 15) return 'good';
  if (risk < 30) return 'fair';
  if (risk < 50) return 'congested';
  return 'critical';
}

export function CollisionWidget() {
  const { lbtStats, isLoading, error } = useLBTData();

  const collisionRisk = lbtStats ? estimateCollisionRisk(lbtStats) : 0;
  const status = lbtStats ? getCollisionStatus(collisionRisk) : 'unknown';
  const maxBackoff = lbtStats?.maxBackoffMs ?? 0;

  return (
    <MiniWidget
      title="Collision Risk"
      icon={<Zap className="mini-widget-icon" />}
      value={collisionRisk.toFixed(1)}
      unit="%"
      status={status}
      subtitle={lbtStats ? `Max backoff: ${Math.round(maxBackoff)}ms` : undefined}
      isLoading={isLoading}
      error={error}
    />
  );
}

export default CollisionWidget;
