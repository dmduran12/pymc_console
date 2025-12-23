/**
 * NoiseFloorWidget - Displays current noise floor
 *
 * Shows the current noise floor reading in dBm from the /api/stats endpoint.
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

export function NoiseFloorWidget() {
  const { noiseFloor, isLoading, error } = useLBTData();

  const status = getNoiseStatus(noiseFloor);

  return (
    <MiniWidget
      title="Noise Floor"
      icon={<AudioWaveform className="mini-widget-icon" />}
      value={noiseFloor !== null ? Math.round(noiseFloor) : '—'}
      unit={noiseFloor !== null ? 'dBm' : undefined}
      status={status}
      subtitle="Current reading"
      isLoading={isLoading}
      error={error}
    />
  );
}

export default NoiseFloorWidget;
