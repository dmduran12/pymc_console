/**
 * LBTRetryWidget - Displays LBT (Listen Before Talk) retry rate
 *
 * Shows the percentage of transmissions that required CAD backoff retries,
 * with average backoff time in the subtitle and a 24h sparkline.
 */

import { useMemo } from 'react';
import { RefreshCwOff } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Status color map using CSS variables */
const STATUS_COLORS: Record<ComputedChannelHealth['status'] | 'unknown', string> = {
  excellent: 'var(--signal-excellent)',
  good: 'var(--signal-good)',
  fair: 'var(--signal-fair)',
  congested: 'var(--signal-poor)',
  critical: 'var(--signal-critical)',
  unknown: 'var(--text-muted)',
};

/** Convert retry rate to status color */
function getRetryStatus(rate: number): ComputedChannelHealth['status'] {
  if (rate < 2) return 'excellent';
  if (rate < 5) return 'good';
  if (rate < 10) return 'fair';
  if (rate < 20) return 'congested';
  return 'critical';
}

export function LBTRetryWidget() {
  const { lbtStats, isLoading, error } = useLBTData();

  const retryRate = lbtStats?.retryRate ?? 0;
  const avgBackoff = lbtStats?.avgBackoffMs ?? 0;
  const status = lbtStats ? getRetryStatus(retryRate) : 'unknown';

  // Transform hourly data for Recharts sparkline
  const hourlyRates = lbtStats?.hourlyRetryRates;
  const chartData = useMemo(() => {
    if (!hourlyRates || hourlyRates.length < 2) return [];
    return hourlyRates.map((value) => ({ value }));
  }, [hourlyRates]);

  const strokeColor = STATUS_COLORS[status];

  return (
    <MiniWidget
      title="LBT Retries"
      icon={<RefreshCwOff className="mini-widget-icon" />}
      value={retryRate.toFixed(1)}
      unit="%"
      status={status}
      subtitle={lbtStats ? `Avg ${Math.round(avgBackoff)}ms backoff` : undefined}
      isLoading={isLoading}
      error={error}
    >
      <div className="mini-widget-sparkline">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={1}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full" />
        )}
      </div>
    </MiniWidget>
  );
}

export default LBTRetryWidget;
