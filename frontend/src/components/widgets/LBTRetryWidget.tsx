/**
 * LBTRetryWidget - Displays LBT (Listen Before Talk) retry rate
 *
 * Shows the percentage of transmissions that required CAD backoff retries,
 * with average backoff time in the subtitle and a 24h sparkline.
 */

import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { MiniWidget } from './MiniWidget';
import { useLBTData } from './LBTDataContext';
import type { ChannelHealthStatus } from '@/types/api';

/** Status color map using CSS variables */
const STATUS_COLORS: Record<ChannelHealthStatus | 'unknown', string> = {
  excellent: 'var(--signal-excellent)',
  good: 'var(--signal-good)',
  fair: 'var(--signal-fair)',
  congested: 'var(--signal-poor)',
  critical: 'var(--signal-critical)',
  unknown: 'var(--text-muted)',
};

/** Convert retry rate to status color */
function getRetryStatus(rate: number): ChannelHealthStatus {
  if (rate < 2) return 'excellent';
  if (rate < 5) return 'good';
  if (rate < 10) return 'fair';
  if (rate < 20) return 'congested';
  return 'critical';
}

export function LBTRetryWidget() {
  const { lbtStats, isTrendLoading, error } = useLBTData();

  const retryRate = lbtStats?.lbt_retry_rate ?? 0;
  const avgBackoff = lbtStats?.avg_backoff_ms ?? 0;
  const status = lbtStats ? getRetryStatus(retryRate) : 'unknown';

  // Transform hourly data for Recharts
  const byHour = lbtStats?.by_hour;
  const chartData = useMemo(() => {
    if (!byHour || byHour.length < 2) return [];
    return byHour.map((h) => ({ value: h.retry_rate }));
  }, [byHour]);

  const strokeColor = STATUS_COLORS[status];

  return (
    <MiniWidget
      title="LBT Retries"
      icon={<RefreshCw className="mini-widget-icon" />}
      value={retryRate.toFixed(1)}
      unit="%"
      status={status}
      subtitle={lbtStats ? `Avg ${Math.round(avgBackoff)}ms backoff` : undefined}
      isLoading={isTrendLoading}
      error={error}
    >
      {chartData.length > 0 && (
        <div className="mini-widget-sparkline">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </MiniWidget>
  );
}

export default LBTRetryWidget;
