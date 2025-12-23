/**
 * CADTunerWidget - CAD Threshold Auto-Tuner toggle with activity meter
 *
 * This widget provides a toggle to enable/disable the CAD (Channel Activity Detection)
 * auto-tuner feature, plus a real-time activity indicator showing tuning activity.
 *
 * Note: The auto-tuner is a planned feature. This widget currently shows a placeholder
 * state and will be fully functional when the backend CAD tuner API is implemented.
 */

import { useState } from 'react';
import { CircleGauge } from 'lucide-react';
import { MiniWidget } from './MiniWidget';

export function CADTunerWidget() {
  // Placeholder state - will connect to backend when CAD tuner API is available
  const [enabled, setEnabled] = useState(false);
  const [tunerActivity] = useState(0); // 0-100, represents recent tuning activity

  // Toggle handler (placeholder - will call API when implemented)
  const handleToggle = () => {
    setEnabled((prev) => !prev);
    // TODO: Call backend API to enable/disable CAD auto-tuner
    // await setCADTunerEnabled(!enabled);
  };

  // Activity indicator
  const activityDisplay = (
    <div className="flex flex-col gap-1 mt-1">
      <div className="mini-widget-toggle">
        <div
          className={`mini-widget-toggle-track ${enabled ? 'active' : ''}`}
          onClick={handleToggle}
          role="switch"
          aria-checked={enabled}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggle();
            }
          }}
        >
          <div className="mini-widget-toggle-thumb" />
        </div>
        <span className="text-xs text-text-muted">
          {enabled ? 'Auto' : 'Manual'}
        </span>
      </div>

      {/* Activity meter (shows when enabled) */}
      {enabled && (
        <div className="mini-widget-progress">
          <div
            className="mini-widget-progress-bar good"
            style={{ width: `${tunerActivity}%` }}
          />
        </div>
      )}
    </div>
  );

  return (
    <MiniWidget
      title="CAD Tuner"
      icon={<CircleGauge className="mini-widget-icon" />}
      subtitle={enabled ? 'Adjusting thresholds…' : 'Tap to enable'}
    >
      {activityDisplay}
    </MiniWidget>
  );
}

export default CADTunerWidget;
