/**
 * Map Layer Components
 * 
 * Rendering layers for the ContactsMap, ordered from bottom to top:
 * 1. TopologyEdges - Validated + weak topology connections
 * 2. NeighborEdges - Dashed lines to zero-hop neighbors
 * 3. NodeMarkers - All node markers with icons and popups
 */

export {
  TopologyEdges,
  type TopologyEdgesProps,
  type EdgePolylineData,
} from './TopologyEdges';

export {
  NeighborEdges,
  type NeighborEdgesProps,
  type NeighborPolylineData,
} from './NeighborEdges';

export {
  NodeMarkers,
  type NodeMarkersProps,
  type LocalNode,
} from './NodeMarkers';
