/**
 * NoiseFloorWidget - Displays current noise floor with trend
 *
 * Shows the most recent noise floor reading in dBm with trend indicator
 * showing if noise is rising (worse), falling (better), or stable.
 */

import { Radio } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData } from './LBTDataContext';
import type { ChannelHealthStatus } from '@/types/api';

/** Convert noise floor to status color (lower is better) */
function getNoiseStatus(noise: number | null): ChannelHealthStatus {
  if (noise === null) return 'excellent';
  if (noise < -110) return 'excellent';
  if (noise < -100) return 'good';
  if (noise < -90) return 'fair';
  if (noise < -80) return 'congested';
  return 'critical';
}

/** Convert trend to widget trend format */
function mapTrend(trend: 'rising' | 'falling' | 'stable'): 'up' | 'down' | 'stable' {
  // Rising noise = worse = up (red), falling = better = down (green)
  if (trend === 'rising') return 'up';
  if (trend === 'falling') return 'down';
  return 'stable';
}

export function NoiseFloorWidget() {
  const { noiseFloor, isTrendLoading, error } = useLBTData();

  const current = noiseFloor?.current ?? noiseFloor?.avg_noise_floor ?? null;
  const status = getNoiseStatus(current);
  const trend = noiseFloor?.trend ? mapTrend(noiseFloor.trend) : undefined;

  // Build subtitle with range
  let subtitle: string | undefined;
  if (noiseFloor) {
    const min = Math.round(noiseFloor.min_noise_floor);
    const max = Math.round(noiseFloor.max_noise_floor);
    subtitle = `Range: ${min} to ${max} dBm`;
  }

  return (
    <MiniWidget
      title="Noise Floor"
      icon={<Radio className="mini-widget-icon" />}
      value={current !== null ? Math.round(current) : '—'}
      unit={current !== null ? 'dBm' : undefined}
      status={status}
      trend={trend}
      subtitle={subtitle}
      isLoading={isTrendLoading}
      error={error}
    />
  );
}

export default NoiseFloorWidget;
