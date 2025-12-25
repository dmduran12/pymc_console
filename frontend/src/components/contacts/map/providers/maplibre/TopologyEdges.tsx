/**
 * MapLibre TopologyEdges Layer Component
 * 
 * Renders topology edges (validated + weak) as animated lines.
 * Direct port from Leaflet version - maintains exact visual parity.
 * 
 * Features:
 * - Trace-in animation when topology is toggled on
 * - Retract animation when topology is toggled off
 * - Weight-based thickness with smooth interpolation
 * - Hover state with color reveal (gray→type color)
 * - Loop edges rendered as parallel double-lines
 * - Tooltips with edge metadata
 * 
 * Implementation:
 * - Uses GeoJSON Source + Line Layer for efficient rendering
 * - Animations update GeoJSON coordinates (animated "to" point)
 * - Hover detection via layer interactivity
 * 
 * @module providers/maplibre/TopologyEdges
 */

import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/maplibre';
import type { LayerProps } from 'react-map-gl/maplibre';
import type { TopologyEdge } from '@/lib/mesh-topology';
import { getLinkQualityWeight } from '@/lib/mesh-topology';
import type { NeighborInfo } from '@/types/api';
import { DESIGN } from '../../constants';
import { getEdgeColor } from '../../utils/edge-color';
import { getParallelOffsets } from '../../utils/parallel-offset';

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
// GeoJSON Builders
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeFeatureProperties {
  key: string;
  color: string;
  width: number;
  opacity: number;
  isLoopEdge: boolean;
  isBackbone: boolean;
  isDirectPath: boolean;
  isHubConnection: boolean;
  certainCount: number;
  confidence: number;
  symmetryRatio: number;
  dominantDirection: string;
  fromName: string;
  toName: string;
}

// Convert [lat, lng] to GeoJSON [lng, lat]
function toGeoJSON(coord: [number, number]): [number, number] {
  return [coord[1], coord[0]];
}

/**
 * Build GeoJSON for weak edges (emerging connections).
 */
function buildWeakEdgesGeoJSON(
  weakPolylines: EdgePolylineData[],
  edgeAnimProgress: Map<string, number>
): GeoJSON.FeatureCollection<GeoJSON.LineString, EdgeFeatureProperties> {
  const features: GeoJSON.Feature<GeoJSON.LineString, EdgeFeatureProperties>[] = [];
  
  for (const { from, to, edge } of weakPolylines) {
    const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
    if (traceProgress <= 0) continue;
    
    // Animate "to" position for trace effect (in [lat, lng] format, like Leaflet)
    const animatedToLatLng: [number, number] = [
      from[0] + (to[0] - from[0]) * traceProgress, // lat
      from[1] + (to[1] - from[1]) * traceProgress, // lng
    ];
    
    features.push({
      type: 'Feature',
      properties: {
        key: edge.key,
        color: DESIGN.edges.restDim,
        width: 1.5,
        opacity: 0.5 * traceProgress,
        isLoopEdge: false,
        isBackbone: false,
        isDirectPath: false,
        isHubConnection: false,
        certainCount: edge.certainCount,
        confidence: edge.avgConfidence ?? 0.7,
        symmetryRatio: edge.symmetryRatio ?? 1,
        dominantDirection: edge.dominantDirection ?? 'balanced',
        fromName: '',
        toName: '',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          toGeoJSON(from),
          toGeoJSON(animatedToLatLng),
        ],
      },
    });
  }
  
  return { type: 'FeatureCollection', features };
}

/**
 * Build GeoJSON for validated edges.
 * Loop edges return two parallel line features.
 */
function buildValidatedEdgesGeoJSON(
  validatedPolylines: EdgePolylineData[],
  edgeAnimProgress: Map<string, number>,
  weightAnimProgress: number,
  animStartWeights: Map<string, number>,
  animTargetWeights: Map<string, number>,
  maxCertainCount: number,
  loopEdgeKeys: Set<string>,
  backboneEdgeKeys: Set<string>,
  hoveredEdgeKey: string | null,
  highlightedEdgeKey: string | null | undefined,
  neighbors: Record<string, NeighborInfo>
): GeoJSON.FeatureCollection<GeoJSON.LineString, EdgeFeatureProperties> {
  const features: GeoJSON.Feature<GeoJSON.LineString, EdgeFeatureProperties>[] = [];
  
  for (const { from, to, edge } of validatedPolylines) {
    const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
    if (traceProgress <= 0) continue;
    
    // Calculate weight with smooth interpolation
    const targetWeight = animTargetWeights.get(edge.key) 
      ?? getLinkQualityWeight(edge.certainCount, maxCertainCount);
    const startWeight = animStartWeights.get(edge.key) ?? targetWeight;
    const animatedWeight = startWeight + (targetWeight - startWeight) * weightAnimProgress;
    
    const isLoopEdge = loopEdgeKeys.has(edge.key);
    const isBackbone = backboneEdgeKeys.has(edge.key);
    const confidence = edge.avgConfidence ?? 0.7;
    const isHovered = hoveredEdgeKey === edge.key;
    const isAnyHovered = hoveredEdgeKey !== null;
    const isHighlighted = highlightedEdgeKey === edge.key;
    
    // Get names for tooltip
    const fromNeighbor = neighbors[edge.fromHash];
    const toNeighbor = neighbors[edge.toHash];
    const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
    const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
    
    // Animate "to" position for trace effect (in [lat, lng] format, like Leaflet)
    const animatedToLatLng: [number, number] = [
      from[0] + (to[0] - from[0]) * traceProgress, // lat
      from[1] + (to[1] - from[1]) * traceProgress, // lng
    ];
    
    // Opacity scales with trace progress
    const baseOpacity = Math.min(traceProgress * 1.5, 1) * DESIGN.edgeOpacity;
    
    // Hover effect: dim non-hovered edges when any edge is hovered
    const hoverOpacityMult = isAnyHovered ? (isHovered ? 1.25 : 0.4) : 1;
    
    // ─── LOOP EDGES: Parallel double-lines ─────────────────────────────────
    if (isLoopEdge) {
      // getParallelOffsets expects [lat, lng] and returns [lat, lng]
      const { line1, line2 } = getParallelOffsets(from, animatedToLatLng, animatedWeight * 1.5);
      const loopColor = isHovered ? DESIGN.edges.hoverLoop : DESIGN.edges.rest;
      const loopOpacity = baseOpacity * 1.1 * hoverOpacityMult;
      const loopWeight = isHovered 
        ? Math.max(2.5, animatedWeight * 0.8) 
        : Math.max(1.5, animatedWeight * 0.6);
      
      // First parallel line
      features.push({
        type: 'Feature',
        properties: {
          key: `${edge.key}-loop1`,
          color: loopColor,
          width: loopWeight,
          opacity: loopOpacity,
          isLoopEdge: true,
          isBackbone: false,
          isDirectPath: edge.isDirectPathEdge ?? false,
          isHubConnection: edge.isHubConnection ?? false,
          certainCount: edge.certainCount,
          confidence,
          symmetryRatio: edge.symmetryRatio ?? 1,
          dominantDirection: edge.dominantDirection ?? 'balanced',
          fromName,
          toName,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            toGeoJSON(line1[0]),
            toGeoJSON(line1[1]),
          ],
        },
      });
      
      // Second parallel line
      features.push({
        type: 'Feature',
        properties: {
          key: `${edge.key}-loop2`,
          color: loopColor,
          width: loopWeight,
          opacity: loopOpacity,
          isLoopEdge: true,
          isBackbone: false,
          isDirectPath: edge.isDirectPathEdge ?? false,
          isHubConnection: edge.isHubConnection ?? false,
          certainCount: edge.certainCount,
          confidence,
          symmetryRatio: edge.symmetryRatio ?? 1,
          dominantDirection: edge.dominantDirection ?? 'balanced',
          fromName,
          toName,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            toGeoJSON(line2[0]),
            toGeoJSON(line2[1]),
          ],
        },
      });
      
      continue;
    }
    
    // ─── STANDARD EDGES ────────────────────────────────────────────────────
    const edgeColor = isHighlighted 
      ? '#FFD700' 
      : getEdgeColor(isHovered, edge.isDirectPathEdge ?? false, false, isBackbone, confidence);
    
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
    
    features.push({
      type: 'Feature',
      properties: {
        key: edge.key,
        color: edgeColor,
        width: finalWeight,
        opacity: finalOpacity,
        isLoopEdge: false,
        isBackbone,
        isDirectPath: edge.isDirectPathEdge ?? false,
        isHubConnection: edge.isHubConnection ?? false,
        certainCount: edge.certainCount,
        confidence,
        symmetryRatio: edge.symmetryRatio ?? 1,
        dominantDirection: edge.dominantDirection ?? 'balanced',
        fromName,
        toName,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          toGeoJSON(from),
          toGeoJSON(animatedToLatLng),
        ],
      },
    });
  }
  
  return { type: 'FeatureCollection', features };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer Styles
// ═══════════════════════════════════════════════════════════════════════════════

const weakEdgesLayerStyle: LayerProps = {
  id: 'topology-weak-edges',
  type: 'line',
  paint: {
    'line-color': ['get', 'color'],
    'line-width': ['get', 'width'],
    'line-opacity': ['get', 'opacity'],
  },
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
};

const validatedEdgesLayerStyle: LayerProps = {
  id: 'topology-validated-edges',
  type: 'line',
  paint: {
    'line-color': ['get', 'color'],
    'line-width': ['get', 'width'],
    'line-opacity': ['get', 'opacity'],
  },
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
};

// Invisible hit-area layer for better edge interactivity
// Wider than visual edges to make hovering easier
const validatedEdgesHitAreaStyle: LayerProps = {
  id: 'topology-validated-edges-hitarea',
  type: 'line',
  paint: {
    'line-color': 'transparent',
    'line-width': 16, // Much wider than visual edges for easy hover
    'line-opacity': 0,
  },
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

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
  onEdgeHover: _onEdgeHover, // Hover handled at map level now
  highlightedEdgeKey,
  neighbors,
}: TopologyEdgesProps) {
  // Whether we should render - computed before hooks to maintain hook order
  const shouldRender = showTopology || isExiting;
  
  // Build GeoJSON data (always call hooks, even if not rendering)
  const weakEdgesData = useMemo(
    () => shouldRender ? buildWeakEdgesGeoJSON(weakPolylines, edgeAnimProgress) : { type: 'FeatureCollection' as const, features: [] },
    [weakPolylines, edgeAnimProgress, shouldRender]
  );
  
  const validatedEdgesData = useMemo(
    () => shouldRender ? buildValidatedEdgesGeoJSON(
      validatedPolylines,
      edgeAnimProgress,
      weightAnimProgress,
      animStartWeights,
      animTargetWeights,
      maxCertainCount,
      loopEdgeKeys,
      backboneEdgeKeys,
      hoveredEdgeKey,
      highlightedEdgeKey,
      neighbors
    ) : { type: 'FeatureCollection' as const, features: [] },
    [
      validatedPolylines,
      edgeAnimProgress,
      weightAnimProgress,
      animStartWeights,
      animTargetWeights,
      maxCertainCount,
      loopEdgeKeys,
      backboneEdgeKeys,
      hoveredEdgeKey,
      highlightedEdgeKey,
      neighbors,
      shouldRender,
    ]
  );
  
  // Don't render content if topology is off and not exiting
  if (!shouldRender) {
    return null;
  }
  
  return (
    <>
      {/* ─── WEAK EDGES (underneath) ─────────────────────────────────────── */}
      <Source id="weak-edges" type="geojson" data={weakEdgesData}>
        <Layer {...weakEdgesLayerStyle} />
      </Source>
      
      {/* ─── VALIDATED EDGES ───────────────────────────────────────────── */}
      <Source id="validated-edges" type="geojson" data={validatedEdgesData}>
        {/* Hit-area layer (invisible, wider for easy hover detection) - rendered first (below) */}
        <Layer {...validatedEdgesHitAreaStyle} />
        {/* Visual layer */}
        <Layer {...validatedEdgesLayerStyle} />
      </Source>
      
      {/* Note: Tooltips now handled at map level for proper interactivity */}
    </>
  );
}

// Export types and constants needed by parent
export type { EdgeFeatureProperties };

// Layer IDs for interactiveLayerIds
export const TOPOLOGY_EDGE_LAYER_IDS = [
  'topology-validated-edges-hitarea',
  'topology-validated-edges',
] as const;
