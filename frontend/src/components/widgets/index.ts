/**
 * Widget Components - Barrel Export
 *
 * Mini-widgets for the LBT Insights dashboard row.
 * These compact cards display real-time channel health, congestion,
 * and link quality metrics.
 *
 * Data Flow:
 * - LBTDataProvider consolidates all API calls
 * - Channel Health: 1h window, 15s refresh (real-time)
 * - Trend widgets: 24h window, 60s refresh (LBT, noise, links)
 */

export { MiniWidget } from './MiniWidget';
export type { MiniWidgetProps } from './MiniWidget';

// Data provider
export { LBTDataProvider, useLBTData } from './LBTDataContext';
export type { LBTData, LBTDataProviderProps } from './LBTDataContext';

// LBT (Listen Before Talk) widgets
export { LBTRetryWidget } from './LBTRetryWidget';
export { ChannelBusyWidget } from './ChannelBusyWidget';

// Noise floor widget
export { NoiseFloorWidget } from './NoiseFloorWidget';

// Link quality widgets
export { NetworkScoreWidget } from './NetworkScoreWidget';
export { BestWorstLinkWidget } from './BestWorstLinkWidget';

// Analysis widgets
export { CollisionWidget } from './CollisionWidget';
export { ChannelHealthWidget } from './ChannelHealthWidget';
export { CADTunerWidget } from './CADTunerWidget';

// Container (includes LBTDataProvider)
export { WidgetRow } from './WidgetRow';
