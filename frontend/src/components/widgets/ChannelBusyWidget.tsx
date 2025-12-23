/**
 * ChannelBusyWidget - Displays channel busy event count
 *
 * Shows the number of times the channel remained busy after max CAD attempts,
 * indicating serious congestion issues.
 */

import { Ban } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Convert busy rate to status color */
function getBusyStatus(rate: number): ComputedChannelHealth['status'] {
  if (rate < 0.5) return 'excellent';
  if (rate < 1) return 'good';
  if (rate < 2) return 'fair';
  if (rate < 5) return 'congested';
  return 'critical';
}

export function ChannelBusyWidget() {
  const { lbtStats, isLoading, error } = useLBTData();

  const busyEvents = lbtStats?.channelBusyCount ?? 0;
  const totalTx = lbtStats?.totalPacketsWithLBT ?? 0;
  const busyRate = lbtStats?.channelBusyRate ?? 0;
  const status = lbtStats ? getBusyStatus(busyRate) : 'unknown';

  return (
    <MiniWidget
      title="Ch. Busy"
      icon={<Ban className="mini-widget-icon" />}
      value={busyEvents}
      status={status}
      subtitle={lbtStats ? `${busyRate.toFixed(2)}% of ${totalTx} TX` : undefined}
      isLoading={isLoading}
      error={error}
    />
  );
}

export default ChannelBusyWidget;
