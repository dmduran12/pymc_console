/**
 * MapLibre Provider Module
 * 
 * MapLibre GL JS implementations for the ContactsMap component.
 * Direct port from Leaflet - maintains exact visual and behavioral parity.
 * 
 * Usage:
 * ```tsx
 * import { 
 *   NodeMarkers, 
 *   TopologyEdges, 
 *   NeighborEdges,
 *   FitBoundsOnce,
 *   ZoomToNode,
 *   EdgeHighlighter,
 * } from './providers/maplibre';
 * ```
 * 
 * @module providers/maplibre
 */

// Icon factories
export {
  createRingIconHtml,
  createFilledIconHtml,
  createLocalIconHtml,
  createRoomServerIconHtml,
  createMarkerElement,
  clearIconCache,
  MARKER_SIZE,
  NEIGHBOR_OUTER_RING_SIZE,
} from './icons';

// Layer components
export { NodeMarkers } from './NodeMarkers';
export type { NodeMarkersProps, LocalNode } from './NodeMarkers';

export { TopologyEdges, TOPOLOGY_EDGE_LAYER_IDS } from './TopologyEdges';
export type { TopologyEdgesProps, EdgePolylineData, EdgeFeatureProperties } from './TopologyEdges';

export { NeighborEdges, NEIGHBOR_EDGE_LAYER_IDS } from './NeighborEdges';
export type { NeighborEdgesProps, NeighborPolylineData, NeighborEdgeProperties } from './NeighborEdges';

// Map helpers
export {
  FitBoundsOnce,
  ZoomToNode,
  EdgeHighlighter,
  useMapInstance,
} from './MapHelpers';

// Main component
export { ContactsMapML } from './ContactsMapML';
export type { ContactsMapMLProps } from './ContactsMapML';
