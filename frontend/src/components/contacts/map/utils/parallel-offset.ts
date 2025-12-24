/**
 * Parallel Offset Utilities
 * 
 * Calculates offset positions for parallel (double) lines.
 * Used for loop edges to visually indicate redundancy.
 */

export type Coordinate = [number, number];

export interface ParallelLines {
  line1: [Coordinate, Coordinate];
  line2: [Coordinate, Coordinate];
}

/**
 * Calculate offset positions for parallel (double) lines.
 * Used for loop edges to visually indicate redundancy.
 * 
 * @param from - Starting coordinate [lat, lng]
 * @param to - Ending coordinate [lat, lng]
 * @param offset - Visual offset amount (will be scaled for geographic coordinates)
 * @returns Two parallel line segments
 */
export function getParallelOffsets(
  from: Coordinate,
  to: Coordinate,
  offset: number
): ParallelLines {
  // Calculate perpendicular offset
  const dx = to[1] - from[1]; // longitude diff
  const dy = to[0] - from[0]; // latitude diff
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len === 0) {
    return {
      line1: [from, to],
      line2: [from, to],
    };
  }
  
  // Perpendicular unit vector (normalized)
  const perpX = -dy / len;
  const perpY = dx / len;
  
  // Scale offset (convert degrees to approximate visual offset)
  const scale = offset * 0.00002; // Adjust for reasonable visual separation
  
  const offsetX = perpX * scale;
  const offsetY = perpY * scale;
  
  return {
    line1: [
      [from[0] + offsetX, from[1] + offsetY],
      [to[0] + offsetX, to[1] + offsetY],
    ],
    line2: [
      [from[0] - offsetX, from[1] - offsetY],
      [to[0] - offsetX, to[1] - offsetY],
    ],
  };
}
