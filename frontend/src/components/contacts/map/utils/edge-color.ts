/**
 * Edge Color Utilities
 * 
 * Determines edge colors based on state (rest vs hovered) and type.
 */

import { DESIGN } from '../constants';

/**
 * Get edge color based on state (rest vs hovered) and type.
 * 
 * Design philosophy:
 * - At rest: All edges are gray (unified, calm aesthetic)
 * - On hover: Color reveals the edge type (direct=teal, loop=indigo, standard=bright gray)
 * 
 * @param isHovered - Whether this specific edge is being hovered
 * @param isDirectPath - Whether this edge is a verified direct path
 * @param isLoopEdge - Whether this edge is part of a loop (redundant path)
 * @param isBackbone - Whether this edge is a backbone (high-traffic) edge  
 * @param confidence - Edge avgConfidence (0-1) - affects rest brightness
 * @returns Hex color string
 */
export function getEdgeColor(
  isHovered: boolean,
  isDirectPath: boolean = false,
  isLoopEdge: boolean = false,
  isBackbone: boolean = false,
  confidence: number = 0.7
): string {
  // Hover state: reveal edge type via color
  if (isHovered) {
    if (isDirectPath) return DESIGN.edges.hoverDirect;  // Teal
    if (isLoopEdge) return DESIGN.edges.hoverLoop;      // Indigo
    return DESIGN.edges.hoverStandard;                  // Bright gray
  }
  
  // Rest state: unified gray, brightness varies with confidence/backbone
  if (isBackbone) {
    return confidence >= 0.75 ? DESIGN.edges.restBright : DESIGN.edges.rest;
  }
  
  // Standard edges: subtle brightness gradient based on confidence
  if (confidence >= 0.85) return DESIGN.edges.rest;      // Gray-600
  if (confidence >= 0.70) return DESIGN.edges.restDim;   // Gray-700
  return '#1F2937';  // Gray-800 - very low confidence
}
