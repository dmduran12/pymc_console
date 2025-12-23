/**
 * ChannelBusyWidget - Displays channel busy event count
 *
 * Shows the number of times the channel remained busy after max CAD attempts,
 * indicating serious congestion issues.
 */

import { Ban } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData } from './LBTDataContext';
import type { ChannelHealthStatus } from '@/types/api';

/** Convert busy events count to status color */
function getBusyStatus(count: number, totalTx: number): ChannelHealthStatus {
  if (totalTx === 0) return 'excellent';
  const rate = (count / totalTx) * 100;
  if (rate < 0.5) return 'excellent';
  if (rate < 1) return 'good';
  if (rate < 2) return 'fair';
  if (rate < 5) return 'congested';
  return 'critical';
}

export function ChannelBusyWidget() {
  const { lbtStats, isTrendLoading, error } = useLBTData();

  const busyEvents = lbtStats?.channel_busy_events ?? 0;
  const totalTx = lbtStats?.total_tx_packets ?? 0;
  const status = lbtStats ? getBusyStatus(busyEvents, totalTx) : 'unknown';

  // Calculate rate for subtitle
  const busyRate = totalTx > 0 ? ((busyEvents / totalTx) * 100).toFixed(2) : '0.00';

  return (
    <MiniWidget
      title="Ch. Busy"
      icon={<Ban className="mini-widget-icon" />}
      value={busyEvents}
      status={status}
      subtitle={lbtStats ? `${busyRate}% of ${totalTx} TX` : undefined}
      isLoading={isTrendLoading}
      error={error}
    />
  );
}

export default ChannelBusyWidget;
