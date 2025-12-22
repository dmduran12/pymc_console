/**
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║                         GEOGRAPHIC UTILITIES                                   ║
 * ╠═══════════════════════════════════════════════════════════════════════════════╣
 * ║ Shared geographic functions for mesh topology analysis.                        ║
 * ║                                                                               ║
 * ║ Consolidates duplicate implementations from:                                   ║
 * ║   - mesh-topology.ts (buildNeighborAffinity proximity scoring)                ║
 * ║   - prefix-disambiguation.ts (geographic scoring for candidates)              ║
 * ║                                                                               ║
 * ║ PROXIMITY BAND RECONCILIATION:                                                ║
 * ║ The two previous implementations used slightly different bands:                ║
 * ║                                                                               ║
 * ║   mesh-topology.ts:              prefix-disambiguation.ts:                    ║
 * ║   < 100m  = 1.0                  < 500m  = 1.0  (VERY_CLOSE)                  ║
 * ║   < 500m  = 0.8                  < 2km   = 0.8  (CLOSE)                       ║
 * ║   < 1km   = 0.6                  < 5km   = 0.6  (MEDIUM)                      ║
 * ║   < 5km   = 0.4                  < 10km  = 0.4  (FAR)                         ║
 * ║   < 10km  = 0.2                  < 20km  = 0.2  (VERY_FAR)                    ║
 * ║   > 10km  = 0.1                  > 20km  = 0.1                                ║
 * ║                                                                               ║
 * ║ DECISION: Use disambiguation bands (wider) as they're better suited for       ║
 * ║ LoRa mesh networks where links can span several kilometers. The tighter       ║
 * ║ bands from mesh-topology were too aggressive for rural deployments.           ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Distance thresholds for proximity scoring (in meters).
 * Tuned for LoRa mesh networks where links can span several kilometers.
 */
export const PROXIMITY_BANDS = {
  /** < 500m = 1.0 (very close, likely direct RF neighbor) */
  VERY_CLOSE: 500,
  /** < 2km = 0.8 (close) */
  CLOSE: 2000,
  /** < 5km = 0.6 (medium range) */
  MEDIUM: 5000,
  /** < 10km = 0.4 (far) */
  FAR: 10000,
  /** < 20km = 0.2 (very far but possible with good antennas) */
  VERY_FAR: 20000,
  // > 20km = 0.1 (unlikely direct link)
} as const;

/**
 * Proximity scores corresponding to each band.
 * These are the values returned by getProximityScore().
 */
export const PROXIMITY_SCORES = {
  VERY_CLOSE: 1.0,
  CLOSE: 0.8,
  MEDIUM: 0.6,
  FAR: 0.4,
  VERY_FAR: 0.2,
  BEYOND: 0.1,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate distance between two coordinates in meters using Haversine formula.
 * 
 * @param lat1 - Latitude of first point (degrees)
 * @param lon1 - Longitude of first point (degrees)
 * @param lat2 - Latitude of second point (degrees)
 * @param lon2 - Longitude of second point (degrees)
 * @returns Distance in meters
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate proximity score (0-1) based on distance.
 * Closer nodes get higher scores, using LoRa-appropriate distance bands.
 * 
 * @param distanceMeters - Distance in meters
 * @returns Proximity score between 0.1 and 1.0
 */
export function getProximityScore(distanceMeters: number): number {
  if (distanceMeters < PROXIMITY_BANDS.VERY_CLOSE) return PROXIMITY_SCORES.VERY_CLOSE;
  if (distanceMeters < PROXIMITY_BANDS.CLOSE) return PROXIMITY_SCORES.CLOSE;
  if (distanceMeters < PROXIMITY_BANDS.MEDIUM) return PROXIMITY_SCORES.MEDIUM;
  if (distanceMeters < PROXIMITY_BANDS.FAR) return PROXIMITY_SCORES.FAR;
  if (distanceMeters < PROXIMITY_BANDS.VERY_FAR) return PROXIMITY_SCORES.VERY_FAR;
  return PROXIMITY_SCORES.BEYOND;
}

/**
 * Check if coordinates are valid (non-zero).
 * Filters out unset/default coordinates which are often (0, 0).
 * 
 * @param lat - Latitude
 * @param lon - Longitude
 * @returns true if coordinates appear to be intentionally set
 */
export function hasValidCoordinates(lat?: number, lon?: number): boolean {
  return lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0);
}

/**
 * Calculate distance between two nodes if both have valid coordinates.
 * Returns undefined if either node lacks coordinates.
 * 
 * @param node1 - First node with optional lat/lon
 * @param node2 - Second node with optional lat/lon
 * @returns Distance in meters, or undefined if coordinates unavailable
 */
export function calculateNodeDistance(
  node1: { latitude?: number; longitude?: number },
  node2: { latitude?: number; longitude?: number }
): number | undefined {
  if (!hasValidCoordinates(node1.latitude, node1.longitude) ||
      !hasValidCoordinates(node2.latitude, node2.longitude)) {
    return undefined;
  }
  return calculateDistance(
    node1.latitude!,
    node1.longitude!,
    node2.latitude!,
    node2.longitude!
  );
}
