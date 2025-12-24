/**
 * Map Module
 * 
 * Modular components for the ContactsMap visualization.
 * 
 * Architecture:
 * - constants.ts: Design tokens, colors, animation timings
 * - icons.tsx: Leaflet DivIcon factories with caching
 * - animations/: RAF-based animation hooks (edge trace, node fade)
 * - utils/: Pure utility functions (edge color, offsets, zero-hop detection)
 * - helpers/: Small useMap-based components (bounds, zoom, highlight)
 * - layers/: Main rendering components (edges, markers)
 * - overlays/: UI controls positioned on the map
 * 
 * Usage:
 * ```tsx
 * import { DESIGN, createRingIcon, useEdgeAnimation } from './map';
 * ```
 * 
 * @module components/contacts/map
 */

// Constants and design tokens
export * from './constants';

// Icon factories (uses JSX for lucide-react)
export * from './icons';

// Animation hooks
export * from './animations';

// Utility functions
export * from './utils';

// Helper components (useMap hooks)
export * from './helpers';

// Layer components (edges, markers)
export * from './layers';

// Overlay components (legend, controls)
export * from './overlays';
