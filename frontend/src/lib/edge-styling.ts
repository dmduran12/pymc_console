/**
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║                         EDGE STYLING UTILITIES                                 ║
 * ╠═══════════════════════════════════════════════════════════════════════════════╣
 * ║ Functions for determining edge colors and line weights on the topology map.   ║
 * ║                                                                               ║
 * ║ Extracted from mesh-topology.ts for cleaner organization.                     ║
 * ║                                                                               ║
 * ║ RECOMMENDED FUNCTIONS:                                                        ║
 * ║   - getLinkQualityColor(): Color by validation count (green/yellow/red)       ║
 * ║   - getLinkQualityWeight(): Logarithmic weight by validation count            ║
 * ║   - getEdgeColorByHopDistance(): Color by proximity to local node             ║
 * ║   - getCertainEdgeWeight(): Weight by certain observation count               ║
 * ║   - getEdgeWeightByHopDistance(): Weight by proximity + traffic               ║
 * ║                                                                               ║
 * ║ DEPRECATED (kept for backward compatibility):                                 ║
 * ║   - getEdgeWeight(): Simple strength-based weight                             ║
 * ║   - getEdgeColor(): Simple strength-based color                               ║
 * ║   - getUncertainEdgeColor(): Uncertain edges no longer rendered               ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Relative validation thresholds for link quality tiers (% of max).
 * Used by getLinkQualityColor() to determine edge color.
 */
export const LINK_QUALITY_THRESHOLDS = {
  /** 24%+ of max = strong (green) */
  STRONG: 0.24,
  /** 12%+ of max = medium (yellow) */
  MEDIUM: 0.12,
  /** 6%+ of max = weak (red) */
  WEAK: 0.06,
} as const;

/**
 * Absolute validation thresholds for line thickness.
 * Used by getLinkQualityWeight() for logarithmic scaling.
 */
export const EDGE_WEIGHT_THRESHOLDS = {
  /** 300+ validations = max thickness */
  MAX_THICKNESS_AT: 300,
  /** Below 5 = not rendered (filtered elsewhere) */
  MIN_VALIDATIONS: 5,
} as const;

/** Maximum edge weight (pixels) */
const MAX_EDGE_WEIGHT = 6;
/** Minimum edge weight for weakest rendered edges */
const MIN_EDGE_WEIGHT = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// Recommended Functions (Current API)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get color for an edge based on link quality (relative to max validation count).
 * 
 * Color mapping:
 *   - Green (24%+ of max): Strong, well-validated link
 *   - Yellow (12-23%): Medium strength link
 *   - Red (<12%): Weak link, may be unreliable
 * 
 * All colors are fully opaque (no alpha).
 * 
 * @param certainCount - Number of certain observations for this edge
 * @param maxCertainCount - Maximum certain count across all edges (for normalization)
 * @returns CSS color string (rgb format)
 */
export function getLinkQualityColor(certainCount: number, maxCertainCount: number): string {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;

  if (normalized >= LINK_QUALITY_THRESHOLDS.STRONG) {
    return 'rgb(74, 222, 128)'; // green-400 - strong link
  } else if (normalized >= LINK_QUALITY_THRESHOLDS.MEDIUM) {
    return 'rgb(250, 204, 21)'; // yellow-400 - medium link
  } else {
    return 'rgb(248, 113, 113)'; // red-400 - weak link
  }
}

/**
 * Get line weight for an edge based on ABSOLUTE validation count.
 * 
 * Uses LOGARITHMIC scaling so most edges stay thin, only high-validation
 * edges get noticeably thicker. This prevents visual clutter while still
 * highlighting the most important links.
 * 
 * Scale (approximate):
 *   - 5 validations: 1px (minimum)
 *   - 10 validations: ~2px
 *   - 25 validations: ~3px
 *   - 50 validations: ~4px
 *   - 100+ validations: 6px (maximum)
 * 
 * @param certainCount - Number of certain observations
 * @param _maxCertainCount - Unused (kept for API compatibility with relative functions)
 * @returns Line weight in pixels
 */
export function getLinkQualityWeight(
  certainCount: number,
  _maxCertainCount: number
): number {
  // Clamp to our absolute range
  const clamped = Math.max(
    EDGE_WEIGHT_THRESHOLDS.MIN_VALIDATIONS,
    Math.min(certainCount, EDGE_WEIGHT_THRESHOLDS.MAX_THICKNESS_AT)
  );

  // Logarithmic normalization: log(x) / log(max) gives a 0-1 range that
  // grows quickly at first, then slows down
  const logMin = Math.log(EDGE_WEIGHT_THRESHOLDS.MIN_VALIDATIONS);
  const logMax = Math.log(EDGE_WEIGHT_THRESHOLDS.MAX_THICKNESS_AT);
  const logCurrent = Math.log(clamped);
  const normalized = (logCurrent - logMin) / (logMax - logMin);

  // Interpolate from min to max weight using log-normalized value
  return MIN_EDGE_WEIGHT + (MAX_EDGE_WEIGHT - MIN_EDGE_WEIGHT) * normalized;
}

/**
 * Get line color for an edge based on hop distance from local node.
 * 
 * Closer edges are more vibrant, further edges fade out.
 * Hub connections get a distinct gold/amber color.
 * 
 * @param hopDistance - Hops from local (0 = touches local, 1 = one hop away, etc.)
 * @param isHubConnection - Whether this edge connects to a high-centrality hub node
 * @returns CSS color string (rgba format)
 */
export function getEdgeColorByHopDistance(
  hopDistance: number,
  isHubConnection: boolean = false
): string {
  // Hub connections get a distinct color (gold/amber)
  if (isHubConnection && hopDistance <= 1) {
    return 'rgba(251, 191, 36, 0.85)'; // amber-400
  }

  switch (hopDistance) {
    case 0:
      // Direct connection to local - bright cyan
      return 'rgba(34, 211, 238, 0.9)'; // cyan-400
    case 1:
      // One hop away - green
      return 'rgba(74, 222, 128, 0.8)'; // green-400
    case 2:
      // Two hops - yellow/lime
      return 'rgba(163, 230, 53, 0.7)'; // lime-400
    case 3:
      // Three hops - orange
      return 'rgba(251, 146, 60, 0.6)'; // orange-400
    default:
      // 4+ hops - faded white
      return 'rgba(255, 255, 255, 0.3)';
  }
}

/**
 * Get line weight for an edge based on hop distance and packet count.
 * 
 * Closer, high-traffic edges are thicker. Distance reduces weight
 * to prevent distant edges from overwhelming the visualization.
 * 
 * @param hopDistance - Hops from local node
 * @param normalizedCount - Packet count normalized to 0-1 (relative to max)
 * @param minWeight - Minimum line weight (default: 1)
 * @param maxWeight - Maximum line weight (default: 5)
 * @returns Line weight in pixels
 */
export function getEdgeWeightByHopDistance(
  hopDistance: number,
  normalizedCount: number,
  minWeight: number = 1,
  maxWeight: number = 5
): number {
  // Base weight from packet count
  const countWeight = minWeight + (maxWeight - minWeight) * normalizedCount;

  // Reduce weight for distant edges (min 40% of original)
  const distanceFactor = Math.max(0.4, 1 - hopDistance * 0.15);

  return countWeight * distanceFactor;
}

/**
 * Get line weight for a CERTAIN edge based on how many times the path was validated.
 * 
 * More frequent observations = thicker line.
 * Uses linear scaling between min and max weight.
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 * @param minWeight - Minimum line weight (default: 1.5)
 * @param maxWeight - Maximum line weight (default: 6)
 * @returns Line weight in pixels
 */
export function getCertainEdgeWeight(
  certainCount: number,
  maxCertainCount: number,
  minWeight: number = 1.5,
  maxWeight: number = 6
): number {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  return minWeight + (maxWeight - minWeight) * normalized;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deprecated Functions (Backward Compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get line weight for an edge based on its strength score.
 * 
 * @deprecated Use getLinkQualityWeight() for validation-based weight,
 *             or getEdgeWeightByHopDistance() for distance-based weight.
 * 
 * @param strength - Edge strength (0-1)
 * @param minWeight - Minimum weight (default: 1.5)
 * @param maxWeight - Maximum weight (default: 5)
 * @returns Line weight in pixels
 */
export function getEdgeWeight(
  strength: number,
  minWeight: number = 1.5,
  maxWeight: number = 5
): number {
  return minWeight + (maxWeight - minWeight) * strength;
}

/**
 * Get line color for an edge based on its strength score.
 * 
 * @deprecated Use getEdgeColorByHopDistance() for distance-based coloring,
 *             or getLinkQualityColor() for validation-based coloring.
 * 
 * @param strength - Edge strength (0-1)
 * @returns CSS color string (rgba format)
 */
export function getEdgeColor(strength: number): string {
  if (strength >= 0.7) {
    return 'rgba(74, 222, 128, 0.8)'; // green-400
  } else if (strength >= 0.4) {
    return 'rgba(34, 211, 238, 0.6)'; // cyan-400
  } else {
    return 'rgba(255, 255, 255, 0.35)';
  }
}

/**
 * Get color for an UNCERTAIN edge based on confidence level.
 * 
 * @deprecated Uncertain edges are no longer rendered in the UI.
 *             This function is kept for API compatibility only.
 * 
 * @param confidence - Confidence score (0-1)
 * @returns CSS color string (rgba format)
 */
export function getUncertainEdgeColor(confidence: number): string {
  if (confidence >= 0.9) {
    return 'rgba(196, 181, 253, 0.6)'; // violet-300 - almost certain
  } else if (confidence >= 0.7) {
    return 'rgba(147, 197, 253, 0.5)'; // blue-300 - high confidence
  } else if (confidence >= 0.5) {
    return 'rgba(253, 224, 71, 0.4)'; // yellow-300 - medium confidence
  } else {
    return 'rgba(253, 186, 116, 0.3)'; // orange-300 - low confidence
  }
}
