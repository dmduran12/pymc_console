import { memo } from 'react';
import clsx from 'clsx';

interface SignalIndicatorProps {
  rssi: number;
  snr?: number;
  /** Compact mode for table cells */
  compact?: boolean;
  /** Show numeric values */
  showValues?: boolean;
}

/**
 * Get signal quality level from RSSI
 * Based on typical LoRa sensitivity thresholds
 */
function getSignalLevel(rssi: number): 'excellent' | 'good' | 'fair' | 'weak' | 'poor' {
  if (rssi >= -90) return 'excellent';
  if (rssi >= -100) return 'good';
  if (rssi >= -110) return 'fair';
  if (rssi >= -120) return 'weak';
  return 'poor';
}

function getSignalColor(level: string): string {
  switch (level) {
    case 'excellent': return 'text-accent-success';
    case 'good': return 'text-[#71F8E5]';
    case 'fair': return 'text-[#F9D26F]';
    case 'weak': return 'text-[#FB923C]';
    case 'poor': return 'text-accent-danger';
    default: return 'text-text-muted';
  }
}

function getBarColor(level: string, active: boolean): string {
  if (!active) return 'bg-white/10';
  switch (level) {
    case 'excellent': return 'bg-accent-success';
    case 'good': return 'bg-[#71F8E5]';
    case 'fair': return 'bg-[#F9D26F]';
    case 'weak': return 'bg-[#FB923C]';
    case 'poor': return 'bg-accent-danger';
    default: return 'bg-white/20';
  }
}

/**
 * Visual signal strength indicator with RSSI bars
 */
function SignalIndicatorComponent({ rssi, snr, compact = false, showValues = true }: SignalIndicatorProps) {
  const level = getSignalLevel(rssi);
  const barCount = 4;
  
  // Map signal level to active bar count
  const activeBars = {
    excellent: 4,
    good: 3,
    fair: 2,
    weak: 1,
    poor: 0,
  }[level];

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        {/* Slim signal bars */}
        <div className="flex items-end gap-[2px] h-3">
          {Array.from({ length: barCount }).map((_, i) => (
            <div
              key={i}
              className={clsx(
                'w-[3px] rounded-[1px] transition-colors',
                getBarColor(level, i < activeBars)
              )}
              style={{ height: `${((i + 1) / barCount) * 100}%` }}
            />
          ))}
        </div>
        {showValues && (
          <span className={clsx('text-[10px] font-mono', getSignalColor(level))}>
            {rssi}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Signal bars - refined */}
      <div className="flex items-end gap-[2px] h-3.5">
        {Array.from({ length: barCount }).map((_, i) => (
          <div
            key={i}
            className={clsx(
              'w-[3px] rounded-[1px] transition-colors',
              getBarColor(level, i < activeBars)
            )}
            style={{ height: `${((i + 1) / barCount) * 100}%` }}
          />
        ))}
      </div>
      
      {showValues && (
        <div className="flex flex-col">
          <span className={clsx('text-xs font-mono leading-tight', getSignalColor(level))}>
            {rssi} dBm
          </span>
          {snr !== undefined && (
            <span className="text-[10px] font-mono text-text-muted leading-tight">
              {snr.toFixed(1)} dB
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const SignalIndicator = memo(SignalIndicatorComponent);

/** Get signal quality label */
export function getSignalQualityLabel(rssi: number): string {
  const level = getSignalLevel(rssi);
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Get signal color class for external use */
export function getSignalColorClass(rssi: number): string {
  return getSignalColor(getSignalLevel(rssi));
}
