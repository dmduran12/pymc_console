/**
 * WidgetRow - Container component for LBT Insights widget suite
 *
 * Arranges all 8 mini-widgets in a responsive grid:
 * - Desktop (≥1280px): 8 columns
 * - Tablet (768-1279px): 4 columns
 * - Mobile (<768px): 2 columns
 *
 * Widget order (left to right):
 * 1. Channel Health - composite score (1h window, 15s refresh)
 * 2. LBT Retries - retry rate % (24h window, 60s refresh)
 * 3. Ch. Busy - busy event count (24h window, 60s refresh)
 * 4. Collision Risk - estimated interference (24h window, 60s refresh)
 * 5. Noise Floor - current dBm with trend (24h window, 60s refresh)
 * 6. Network Score - avg link quality (24h window, 60s refresh)
 * 7. Link Range - best/worst neighbors (24h window, 60s refresh)
 * 8. CAD Tuner - auto-tuner toggle (local state only)
 *
 * Uses LBTDataProvider to consolidate API calls - all widgets share data.
 */

import { LBTDataProvider } from './LBTDataContext';
import { ChannelHealthWidget } from './ChannelHealthWidget';
import { LBTRetryWidget } from './LBTRetryWidget';
import { ChannelBusyWidget } from './ChannelBusyWidget';
import { CollisionWidget } from './CollisionWidget';
import { NoiseFloorWidget } from './NoiseFloorWidget';
import { NetworkScoreWidget } from './NetworkScoreWidget';
import { BestWorstLinkWidget } from './BestWorstLinkWidget';
import { CADTunerWidget } from './CADTunerWidget';

export interface WidgetRowProps {
  /** Optional className for additional styling */
  className?: string;
}

export function WidgetRow({ className = '' }: WidgetRowProps) {
  return (
    <LBTDataProvider>
      <div className={`widget-row ${className}`}>
        {/* Health overview first for quick status check */}
        <ChannelHealthWidget />

        {/* Congestion metrics (2 widgets) */}
        <LBTRetryWidget />
        <ChannelBusyWidget />

        {/* Collision analysis */}
        <CollisionWidget />

        {/* Noise floor (1 widget) */}
        <NoiseFloorWidget />

        {/* Link quality (2 widgets) */}
        <NetworkScoreWidget />
        <BestWorstLinkWidget />

        {/* CAD auto-tuner toggle */}
        <CADTunerWidget />
      </div>
    </LBTDataProvider>
  );
}

export default WidgetRow;
