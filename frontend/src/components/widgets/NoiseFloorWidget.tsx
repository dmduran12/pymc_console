/**
 * NoiseFloorWidget - Displays current noise floor with trend indicator
 *
 * Shows the current noise floor reading in dBm from the /api/stats endpoint.
 * Trend arrow indicates if noise is increasing (worse) or decreasing (better).
 */

import { AudioWaveform } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Convert noise floor to status color (lower is better) */
function getNoiseStatus(noise: number | null): ComputedChannelHealth['status'] {
  if (noise === null) return 'excellent';
  if (noise < -110) return 'excellent';
  if (noise < -100) return 'good';
  if (noise < -90) return 'fair';
  if (noise < -80) return 'congested';
  return 'critical';
}

/** Get noise level description */
function getNoiseLabel(noise: number | null): string {
  if (noise === null) return 'No reading';
  if (noise < -115) return 'Very quiet';
  if (noise < -105) return 'Quiet';
  if (noise < -95) return 'Moderate';
  if (noise < -85) return 'Elevated';
  return 'High interference';
}

export function NoiseFloorWidget() {
  const { noiseFloor, trends, isLoading, error } = useLBTData();

  const status = getNoiseStatus(noiseFloor);
  const trend = trends?.noiseFloor.trend;

  return (
    <MiniWidget
      title="Noise Floor"
      icon={<AudioWaveform className="mini-widget-icon" />}
      value={noiseFloor !== null ? Math.round(noiseFloor) : '—'}
      unit={noiseFloor !== null ? 'dBm' : undefined}
      status={status}
      trend={trend}
      subtitle={getNoiseLabel(noiseFloor)}
      isLoading={isLoading}
      error={error}
    />
  );
}

export default NoiseFloorWidget;
