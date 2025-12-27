/**
 * CADTunerWidget - Dual-mode widget: TX Insights (default) or CAD Auto-Tuner (future)
 *
 * CURRENT MODE: TX Insights
 * Shows useful transmission metrics:
 * - Duty cycle usage (% of allowed airtime used)
 * - TX success indicator
 * - Airtime remaining
 *
 * FUTURE MODE: CAD Auto-Tuner (infrastructure preserved)
 * When backend CAD tuner API is implemented, this widget can toggle to:
 * - Enable/disable CAD threshold auto-tuning
 * - Show real-time tuning activity
 * 
 * The CAD tuner infrastructure is preserved for future use - just set
 * showCADTuner=true and implement the API calls.
 */

import { useState, useMemo } from 'react';
import { CircleGauge, Radio } from 'lucide-react';
import { MiniWidget, type WidgetStatus } from './MiniWidget';
import { useLBTData } from './LBTDataContext';

/** Get status based on duty cycle usage */
function getDutyCycleStatus(usagePercent: number): WidgetStatus {
  if (usagePercent < 30) return 'excellent';
  if (usagePercent < 50) return 'good';
  if (usagePercent < 70) return 'fair';
  if (usagePercent < 90) return 'congested';
  return 'critical';
}

/** Format milliseconds as human-readable time */
function formatAirtime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function CADTunerWidget() {
  // ═══════════════════════════════════════════════════════════════════════════
  // CAD TUNER STATE (preserved for future backend integration)
  // ═══════════════════════════════════════════════════════════════════════════
  const [cadEnabled, setCadEnabled] = useState(false);
  const [_tunerActivity] = useState(0); // 0-100, represents recent tuning activity
  
  // Set to true when CAD tuner backend API is available
  const showCADTuner = false;

  // CAD Tuner toggle handler (placeholder - will call API when implemented)
  const handleCADToggle = () => {
    setCadEnabled((prev) => !prev);
    // TODO: Call backend API to enable/disable CAD auto-tuner
    // await setCADTunerEnabled(!cadEnabled);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TX INSIGHTS MODE (default)
  // ═══════════════════════════════════════════════════════════════════════════
  const { stats, lbtStats, isLoading } = useLBTData();
  
  // Calculate duty cycle metrics from stats
  const dutyCycleMetrics = useMemo(() => {
    if (!stats) return null;
    
    const usedMs = stats.airtime_used_ms ?? 0;
    const maxMs = stats.max_airtime_ms ?? 1;
    const remainingMs = stats.airtime_remaining_ms ?? 0;
    const utilizationPercent = stats.utilization_percent ?? (maxMs > 0 ? (usedMs / maxMs) * 100 : 0);
    
    return {
      usedMs,
      maxMs,
      remainingMs,
      utilizationPercent,
    };
  }, [stats]);
  
  // TX success rate from LBT stats
  const txSuccessRate = useMemo(() => {
    if (!lbtStats || lbtStats.totalPacketsWithLBT === 0) return 100;
    // Success = packets that weren't blocked by channel busy
    const blocked = lbtStats.channelBusyCount;
    const total = lbtStats.totalPacketsWithLBT;
    return ((total - blocked) / total) * 100;
  }, [lbtStats]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER: CAD TUNER MODE (future)
  // ═══════════════════════════════════════════════════════════════════════════
  if (showCADTuner) {
    const cadActivityDisplay = (
      <div className="flex flex-col gap-1 mt-1">
        <div className="mini-widget-toggle">
          <div
            className={`mini-widget-toggle-track ${cadEnabled ? 'active' : ''}`}
            onClick={handleCADToggle}
            role="switch"
            aria-checked={cadEnabled}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleCADToggle();
              }
            }}
          >
            <div className="mini-widget-toggle-thumb" />
          </div>
          <span className="text-xs text-text-muted">
            {cadEnabled ? 'Auto' : 'Manual'}
          </span>
        </div>

        {/* Activity meter (shows when enabled) */}
        {cadEnabled && (
          <div className="mini-widget-progress">
            <div
              className="mini-widget-progress-bar good"
              style={{ width: `${_tunerActivity}%` }}
            />
          </div>
        )}
      </div>
    );

    return (
      <MiniWidget
        title="CAD Tuner"
        icon={<CircleGauge className="mini-widget-icon" />}
        subtitle={cadEnabled ? 'Adjusting thresholds…' : 'Tap to enable'}
      >
        {cadActivityDisplay}
      </MiniWidget>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER: TX INSIGHTS MODE (default)
  // ═══════════════════════════════════════════════════════════════════════════
  const utilization = dutyCycleMetrics?.utilizationPercent ?? 0;
  const status = getDutyCycleStatus(utilization);
  const remaining = dutyCycleMetrics?.remainingMs ?? 0;
  
  // Subtitle shows TX success rate or remaining airtime
  const subtitle = txSuccessRate < 99 
    ? `${txSuccessRate.toFixed(0)}% TX success`
    : `${formatAirtime(remaining)} remaining`;

  // Progress bar showing duty cycle usage
  const progressBar = dutyCycleMetrics ? (
    <div className="mini-widget-progress mt-auto">
      <div
        className={`mini-widget-progress-bar ${status}`}
        style={{ width: `${Math.min(utilization, 100)}%` }}
      />
    </div>
  ) : null;

  return (
    <MiniWidget
      title="Duty Cycle"
      icon={<Radio className="mini-widget-icon" />}
      value={utilization.toFixed(1)}
      unit="%"
      status={status}
      subtitle={subtitle}
      isLoading={isLoading}
    >
      {progressBar}
    </MiniWidget>
  );
}

export default CADTunerWidget;
