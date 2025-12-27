/**
 * ChannelHealthWidget - Displays composite channel health score with trend
 *
 * Combines LBT, noise floor, and link quality into a single health score
 * with color-coded status, progress bar visualization, and trend indicator.
 */

import { Cross } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Get human-readable status label */
function getStatusLabel(status: ComputedChannelHealth['status']): string {
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
  const { channelHealth, trends, isLoading, error } = useLBTData();

  const healthScore = channelHealth?.score ?? 0;
  const status = channelHealth?.status ?? 'excellent';
  const trend = trends?.channelHealth.trend;

  // Progress bar showing health score
  const progressBar = channelHealth ? (
    <div className="mini-widget-progress mt-auto">
      <div
        className={`mini-widget-progress-bar ${status}`}
        style={{ width: `${healthScore}%` }}
      />
    </div>
  ) : null;

  return (
    <MiniWidget
      title="Channel Health"
      icon={<Cross className="mini-widget-icon" />}
      value={Math.round(healthScore)}
      unit="/100"
      status={status}
      trend={trend}
      subtitle={channelHealth ? getStatusLabel(status) : undefined}
      isLoading={isLoading}
      error={error}
    >
      {progressBar}
    </MiniWidget>
  );
}

export default ChannelHealthWidget;
