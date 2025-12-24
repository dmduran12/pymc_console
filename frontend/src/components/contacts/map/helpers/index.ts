/**
 * Map Helper Components
 * 
 * Small utility components that use Leaflet's useMap hook.
 * These are rendered inside MapContainer to access the map instance.
 */

export {
  FitBoundsOnce,
  ZoomToNode,
  EdgeHighlighter,
} from './MapHelpers';

// Note: EdgePolylineData type is exported from ./layers to avoid conflicts
