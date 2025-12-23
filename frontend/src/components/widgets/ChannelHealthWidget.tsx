/**
 * ChannelHealthWidget - Displays composite channel health score
 *
 * Combines LBT, noise floor, and link quality into a single health score
 * with color-coded status and progress bar visualization.
 *
 * Note: Uses 1-hour window for real-time responsiveness (vs 24h for trend widgets).
 */

import { HeartPulse } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData } from './LBTDataContext';
import type { ChannelHealthStatus } from '@/types/api';

/** Get human-readable status label */
function getStatusLabel(status: ChannelHealthStatus): string {
  switch (status) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'congested':
      return 'Congested';
    case 'critical':
      return 'Critical';
    default:
      return 'Unknown';
  }
}

export function ChannelHealthWidget() {
  const { channelHealth, isHealthLoading, error } = useLBTData();

  const healthScore = channelHealth?.health_score ?? 0;
  const status = channelHealth?.status ?? 'excellent';

  // Progress bar showing health score
  const progressBar = channelHealth ? (
    <div className="mini-widget-progress">
      <div
        className={`mini-widget-progress-bar ${status}`}
        style={{ width: `${healthScore}%` }}
      />
    </div>
  ) : null;

  return (
    <MiniWidget
      title="Channel Health"
      icon={<HeartPulse className="mini-widget-icon" />}
      value={Math.round(healthScore)}
      unit="/100"
      status={status}
      subtitle={channelHealth ? getStatusLabel(status) : undefined}
      isLoading={isHealthLoading}
      error={error}
    >
      {progressBar}
    </MiniWidget>
  );
}

export default ChannelHealthWidget;
