/**
 * WidgetRow - Container component for Mesh Health widget suite
 *
 * Arranges all 8 mini-widgets in a responsive grid:
 * - Desktop & Tablet (≥768px): 4 columns (2 rows)
 * - Mobile (<768px): 2 columns (4 rows)
 *
 * Uses LBTDataProvider to consolidate API calls - all widgets share data.
 */

import { SquareActivity } from 'lucide-react';
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
      <div className={`mesh-health-container ${className}`}>
        {/* Section Header */}
        <div className="mesh-health-header">
          <SquareActivity className="w-4 h-4 text-accent-primary" />
          <span className="type-label text-text-muted">MESH HEALTH</span>
        </div>
        
        {/* Widget Grid */}
        <div className="widget-row">
          <ChannelHealthWidget />
          <LBTRetryWidget />
          <ChannelBusyWidget />
          <CollisionWidget />
          <NoiseFloorWidget />
          <NetworkScoreWidget />
          <BestWorstLinkWidget />
          <CADTunerWidget />
        </div>
      </div>
    </LBTDataProvider>
  );
}

export default WidgetRow;
