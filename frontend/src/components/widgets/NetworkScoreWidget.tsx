/**
 * NetworkScoreWidget - Displays average network link quality score
 *
 * Shows the mean quality score across all neighbors, with neighbor count
 * in the subtitle.
 */

import { Network } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Convert score (0-100) to status color */
function getScoreStatus(score: number): ComputedChannelHealth['status'] {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'congested';
  return 'critical';
}

export function NetworkScoreWidget() {
  const { linkQuality, isLoading, error } = useLBTData();

  const avgScore = linkQuality?.networkScore ?? 0;
  const neighborCount = linkQuality?.neighbors?.length ?? 0;
  const status = linkQuality ? getScoreStatus(avgScore) : 'unknown';

  return (
    <MiniWidget
      title="Network Score"
      icon={<Network className="mini-widget-icon" />}
      value={Math.round(avgScore)}
      unit="/100"
      status={status}
      subtitle={linkQuality ? `${neighborCount} neighbor${neighborCount !== 1 ? 's' : ''} scored` : undefined}
      isLoading={isLoading}
      error={error}
    />
  );
}

export default NetworkScoreWidget;
