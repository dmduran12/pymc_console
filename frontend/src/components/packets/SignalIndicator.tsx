import { memo, type ReactNode } from 'react';
import clsx from 'clsx';
import { Signal, SignalHigh, SignalMedium, SignalLow, SignalZero, type LucideProps } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════════
// Signal Strength Types & Constants
// ═══════════════════════════════════════════════════════════════════════════════

export type SignalLevel = 'excellent' | 'good' | 'fair' | 'weak' | 'poor';

interface SignalIndicatorProps {
  rssi: number;
  snr?: number;
  /** Compact mode for table cells */
  compact?: boolean;
  /** Show numeric values */
  showValues?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Signal Level & Color Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get signal quality level from RSSI
 * Based on typical LoRa sensitivity thresholds:
 * - Excellent: ≥ -90 dBm (strong signal, close range or good conditions)
 * - Good: -90 to -100 dBm (reliable communication)
 * - Fair: -100 to -110 dBm (usable but may have some packet loss)
 * - Weak: -110 to -120 dBm (marginal, expect retries)
 * - Poor: < -120 dBm (at or near sensitivity limit)
 */
export function getSignalLevel(rssi: number): SignalLevel {
  if (rssi >= -90) return 'excellent';
  if (rssi >= -100) return 'good';
  if (rssi >= -110) return 'fair';
  if (rssi >= -120) return 'weak';
  return 'poor';
}

/**
 * Get text color class for signal level
 * Semantic color mapping:
 * - Excellent: Green (accent-success)
 * - Good: Cyan/Mint (accent-tertiary)
 * - Fair: Yellow (accent-secondary)
 * - Weak: Orange
 * - Poor: Red (accent-danger)
 */
function getSignalColor(level: SignalLevel): string {
  switch (level) {
    case 'excellent': return 'text-accent-success';
    case 'good': return 'text-[#71F8E5]';
    case 'fair': return 'text-[#F9D26F]';
    case 'weak': return 'text-[#FB923C]';
    case 'poor': return 'text-accent-danger';
    default: return 'text-text-muted';
  }
}

function getBarColor(level: SignalLevel, active: boolean): string {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Lucide Signal Icon Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the appropriate Lucide signal icon component for an RSSI value.
 * Uses Lucide's signal icon family:
 * - Signal: Full signal (excellent)
 * - SignalHigh: 3/4 bars (good)
 * - SignalMedium: 2/4 bars (fair)
 * - SignalLow: 1/4 bars (weak)
 * - SignalZero: No bars (poor)
 */
export function getSignalIconComponent(rssi: number): React.ComponentType<LucideProps> {
  const level = getSignalLevel(rssi);
  switch (level) {
    case 'excellent': return Signal;
    case 'good': return SignalHigh;
    case 'fair': return SignalMedium;
    case 'weak': return SignalLow;
    case 'poor': return SignalZero;
    default: return SignalZero;
  }
}

/**
 * Render a Lucide signal icon with appropriate color based on RSSI.
 * @param rssi - Signal strength in dBm
 * @param className - Additional classes to apply (size, etc.)
 * @returns ReactNode with the appropriate colored signal icon
 */
export function SignalIcon({ rssi, className = 'w-4 h-4' }: { rssi: number; className?: string }): ReactNode {
  const level = getSignalLevel(rssi);
  const colorClass = getSignalColor(level);
  const IconComponent = getSignalIconComponent(rssi);
  
  return <IconComponent className={clsx(colorClass, className)} />;
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
      <div className="flex items-center justify-end gap-1.5">
        {/* RSSI value first (left), then bars (right) */}
        {showValues && (
          <span className="text-[10px] font-mono text-text-secondary">
            {rssi}
          </span>
        )}
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
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {/* RSSI value first (left), then bars (right) */}
      {showValues && (
        <div className="flex flex-col items-end">
          <span className="text-xs font-mono text-text-secondary leading-tight">
            {rssi} dBm
          </span>
          {snr !== undefined && (
            <span className="text-[10px] font-mono text-text-muted leading-tight">
              {snr.toFixed(1)} dB
            </span>
          )}
        </div>
      )}
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
