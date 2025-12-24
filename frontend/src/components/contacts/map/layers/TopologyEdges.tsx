/**
 * TopologyEdges Layer Component
 * 
 * Renders topology edges (validated + weak) as animated polylines.
 * 
 * Features:
 * - Trace-in animation when topology is toggled on
 * - Retract animation when topology is toggled off
 * - Weight-based thickness with smooth interpolation
 * - Hover state with color reveal (gray→type color)
 * - Loop edges rendered as parallel double-lines
 * - Tooltips with edge metadata
 * 
 * @module layers/TopologyEdges
 */

import { Polyline, Tooltip } from 'react-leaflet';
import { ArrowRight, RefreshCw, Zap } from 'lucide-react';
import type { TopologyEdge } from '@/lib/mesh-topology';
import { getLinkQualityWeight } from '@/lib/mesh-topology';
import type { NeighborInfo } from '@/types/api';
import { DESIGN } from '../constants';
import { getEdgeColor } from '../utils/edge-color';
import { getParallelOffsets } from '../utils/parallel-offset';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface EdgePolylineData {
  from: [number, number];
  to: [number, number];
  edge: TopologyEdge;
}

export interface TopologyEdgesProps {
  /** Whether topology should be visible (controls rendering) */
  showTopology: boolean;
  /** Whether exit animation is in progress */
  isExiting: boolean;
  /** Validated edge polylines to render */
  validatedPolylines: EdgePolylineData[];
  /** Weak edge polylines to render (underneath validated) */
  weakPolylines: EdgePolylineData[];
  /** Animation progress per edge (0-1) */
  edgeAnimProgress: Map<string, number>;
  /** Weight animation progress (0-1) for interpolation */
  weightAnimProgress: number;
  /** Start weights for interpolation */
  animStartWeights: Map<string, number>;
  /** Target weights for interpolation */
  animTargetWeights: Map<string, number>;
  /** Maximum certain count for weight calculation */
  maxCertainCount: number;
  /** Set of loop edge keys */
  loopEdgeKeys: Set<string>;
  /** Set of backbone edge keys (high-traffic) */
  backboneEdgeKeys: Set<string>;
  /** Currently hovered edge key */
  hoveredEdgeKey: string | null;
  /** Callback when edge hover state changes */
  onEdgeHover: (key: string | null) => void;
  /** Currently highlighted edge key (from PathHealth panel) */
  highlightedEdgeKey?: string | null;
  /** Neighbor lookup for tooltip names */
  neighbors: Record<string, NeighborInfo>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders topology edges with animations, hover states, and tooltips.
 * 
 * Rendering order (back to front):
 * 1. Weak edges (5+ packets but below validation threshold)
 * 2. Standard validated edges
 * 3. Loop edges (parallel double-lines)
 */
export function TopologyEdges({
  showTopology,
  isExiting,
  validatedPolylines,
  weakPolylines,
  edgeAnimProgress,
  weightAnimProgress,
  animStartWeights,
  animTargetWeights,
  maxCertainCount,
  loopEdgeKeys,
  backboneEdgeKeys,
  hoveredEdgeKey,
  onEdgeHover,
  highlightedEdgeKey,
  neighbors,
}: TopologyEdgesProps) {
  // Don't render if topology is off and not in exit animation
  if (!showTopology && !isExiting) {
    return null;
  }

  return (
    <>
      {/* ─── WEAK EDGES (underneath) ─────────────────────────────────────────── */}
      {/* Subtle 10% gray for emerging connections */}
      {weakPolylines.map(({ from, to, edge }) => {
        const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
        
        // Don't render edges that haven't started animating
        if (traceProgress <= 0) return null;
        
        // Animate the "to" position for trace effect
        const animatedTo: [number, number] = [
          from[0] + (to[0] - from[0]) * traceProgress,
          from[1] + (to[1] - from[1]) * traceProgress,
        ];
        
        return (
          <Polyline
            key={`weak-edge-${edge.key}`}
            positions={[from, animatedTo]}
            pathOptions={{
              color: DESIGN.edges.restDim,
              weight: 1.5,
              opacity: 0.5 * traceProgress,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        );
      })}

      {/* ─── VALIDATED EDGES ─────────────────────────────────────────────────── */}
      {validatedPolylines.map(({ from, to, edge }) => {
        // Get animation progress (default to 0 - edges must be explicitly animated)
        const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
        
        // Don't render edges that haven't started animating (or have fully retracted)
        if (traceProgress <= 0) return null;
        
        // Calculate weight with smooth interpolation
        const targetWeight = animTargetWeights.get(edge.key) 
          ?? getLinkQualityWeight(edge.certainCount, maxCertainCount);
        const startWeight = animStartWeights.get(edge.key) ?? targetWeight;
        const animatedWeight = startWeight + (targetWeight - startWeight) * weightAnimProgress;
        
        const isLoopEdge = loopEdgeKeys.has(edge.key);
        const isBackbone = backboneEdgeKeys.has(edge.key);
        const confidence = edge.avgConfidence ?? 0.7;
        
        // Link quality percentage for tooltip
        const linkQuality = maxCertainCount > 0 
          ? (edge.certainCount / maxCertainCount)
          : 0;
        
        // Get names for tooltip
        const fromNeighbor = neighbors[edge.fromHash];
        const toNeighbor = neighbors[edge.toHash];
        const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
        const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
        
        // Animate "to" position for trace effect
        const animatedTo: [number, number] = [
          from[0] + (to[0] - from[0]) * traceProgress,
          from[1] + (to[1] - from[1]) * traceProgress,
        ];
        
        // Opacity scales with trace progress
        const baseOpacity = Math.min(traceProgress * 1.5, 1) * DESIGN.edgeOpacity;
        
        // Hover effect: dim non-hovered edges when any edge is hovered
        const isHovered = hoveredEdgeKey === edge.key;
        const isAnyHovered = hoveredEdgeKey !== null;
        const hoverOpacityMult = isAnyHovered ? (isHovered ? 1.25 : 0.4) : 1;
        
        // ─── LOOP EDGES: Parallel double-lines ─────────────────────────────────
        if (isLoopEdge) {
          const { line1, line2 } = getParallelOffsets(from, animatedTo, animatedWeight * 1.5);
          const loopColor = isHovered ? DESIGN.edges.hoverLoop : DESIGN.edges.rest;
          const loopOpacity = baseOpacity * 1.1 * hoverOpacityMult;
          const loopWeight = isHovered 
            ? Math.max(2.5, animatedWeight * 0.8) 
            : Math.max(1.5, animatedWeight * 0.6);
          
          return (
            <span key={`loop-edge-${edge.key}`}>
              <Polyline
                positions={line1}
                pathOptions={{
                  color: loopColor,
                  weight: loopWeight,
                  opacity: loopOpacity,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
                eventHandlers={{
                  mouseover: () => onEdgeHover(edge.key),
                  mouseout: () => onEdgeHover(null),
                }}
              />
              <Polyline
                positions={line2}
                pathOptions={{
                  color: loopColor,
                  weight: loopWeight,
                  opacity: loopOpacity,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
                eventHandlers={{
                  mouseover: () => onEdgeHover(edge.key),
                  mouseout: () => onEdgeHover(null),
                }}
              >
                <Tooltip permanent={false} direction="auto" className="topology-edge-tooltip">
                  <EdgeTooltipContent
                    fromName={fromName}
                    toName={toName}
                    edge={edge}
                    linkQuality={linkQuality}
                    confidence={confidence}
                    isBackbone={false}
                    isLoopEdge={true}
                  />
                </Tooltip>
              </Polyline>
            </span>
          );
        }
        
        // ─── STANDARD EDGES ────────────────────────────────────────────────────
        const edgeColor = getEdgeColor(isHovered, edge.isDirectPathEdge, false, isBackbone, confidence);
        const isHighlighted = highlightedEdgeKey === edge.key;
        
        // Weight adjustments
        let finalWeight = isHighlighted 
          ? Math.max(animatedWeight * 1.6, 4.5) 
          : (isBackbone ? animatedWeight * 1.3 : animatedWeight);
        if (isHovered && !isHighlighted) {
          finalWeight = Math.max(finalWeight * 1.2, 3);
        }
        
        // Opacity adjustments
        let finalOpacity = isHighlighted 
          ? 0.95 
          : (isBackbone ? baseOpacity * 1.15 : baseOpacity);
        finalOpacity *= hoverOpacityMult;
        
        return (
          <Polyline
            key={`edge-${edge.key}`}
            positions={[from, animatedTo]}
            pathOptions={{
              color: isHighlighted ? '#FFD700' : edgeColor,
              weight: finalWeight,
              opacity: finalOpacity,
              lineCap: 'round',
              lineJoin: 'round',
            }}
            eventHandlers={{
              mouseover: () => onEdgeHover(edge.key),
              mouseout: () => onEdgeHover(null),
            }}
          >
            <Tooltip permanent={false} direction="auto" className="topology-edge-tooltip">
              <EdgeTooltipContent
                fromName={fromName}
                toName={toName}
                edge={edge}
                linkQuality={linkQuality}
                confidence={confidence}
                isBackbone={isBackbone}
                isLoopEdge={false}
              />
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tooltip Content Component
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeTooltipContentProps {
  fromName: string;
  toName: string;
  edge: TopologyEdge;
  linkQuality: number;
  confidence: number;
  isBackbone: boolean;
  isLoopEdge: boolean;
}

/**
 * Tooltip content for topology edges.
 * Shows direction, validation count, and edge type indicators.
 */
function EdgeTooltipContent({
  fromName,
  toName,
  edge,
  linkQuality,
  confidence,
  isBackbone,
  isLoopEdge,
}: EdgeTooltipContentProps) {
  return (
    <div className="text-xs">
      {/* Directional indicator if asymmetric */}
      {(edge.symmetryRatio ?? 1) < 0.7 && edge.dominantDirection !== 'balanced' ? (
        <div className="font-medium text-text-primary flex items-center gap-1">
          {edge.dominantDirection === 'forward' ? (
            <>{fromName} <ArrowRight className="w-3 h-3" /> {toName}</>
          ) : (
            <>{toName} <ArrowRight className="w-3 h-3" /> {fromName}</>
          )}
        </div>
      ) : (
        <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
      )}
      
      <div className="text-text-secondary">
        {edge.certainCount} validations ({Math.round(linkQuality * 100)}%) • {Math.round(confidence * 100)}% conf
      </div>
      
      {isBackbone && (
        <div className="text-gray-300 font-semibold">Backbone</div>
      )}
      
      {isLoopEdge && (
        <div style={{ color: DESIGN.edges.hoverLoop }} className="flex items-center gap-1 mt-0.5">
          <RefreshCw className="w-3 h-3" />
          <span>Redundant path</span>
        </div>
      )}
      
      {edge.isDirectPathEdge && (
        <div className="text-teal-400 flex items-center gap-1">
          <Zap className="w-3 h-3" />
          <span>Direct path</span>
        </div>
      )}
      
      {edge.isHubConnection && !isBackbone && !edge.isDirectPathEdge && (
        <div className="text-amber-400">Hub connection</div>
      )}
    </div>
  );
}
