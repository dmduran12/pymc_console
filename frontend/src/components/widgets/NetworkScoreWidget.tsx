/**
 * NetworkScoreWidget - Displays average network link quality score
 *
 * Shows the mean quality score across all neighbors, with neighbor count
 * in the subtitle.
 */

import { Network } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData } from './LBTDataContext';
import type { ChannelHealthStatus } from '@/types/api';

/** Convert score (0-100) to status color */
function getScoreStatus(score: number): ChannelHealthStatus {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'congested';
  return 'critical';
}

export function NetworkScoreWidget() {
  const { linkQuality, isTrendLoading, error } = useLBTData();

  const avgScore = linkQuality?.avg_network_score ?? 0;
  const neighborCount = linkQuality?.count ?? 0;
  const status = linkQuality ? getScoreStatus(avgScore) : 'unknown';

  return (
    <MiniWidget
      title="Network Score"
      icon={<Network className="mini-widget-icon" />}
      value={Math.round(avgScore)}
      unit="/100"
      status={status}
      subtitle={linkQuality ? `${neighborCount} neighbor${neighborCount !== 1 ? 's' : ''} scored` : undefined}
      isLoading={isTrendLoading}
      error={error}
    />
  );
}

export default NetworkScoreWidget;
