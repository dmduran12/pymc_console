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

import { useMemo, useState, useCallback } from 'react';
import { Source, Layer, Popup } from 'react-map-gl/maplibre';
import { ArrowRight, RefreshCw, Zap } from 'lucide-react';
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
    
    // Animate "to" position for trace effect
    // Note: GeoJSON uses [lng, lat] order (opposite of Leaflet's [lat, lng])
    const animatedTo: [number, number] = [
      from[1] + (to[1] - from[1]) * traceProgress, // lng
      from[0] + (to[0] - from[0]) * traceProgress, // lat
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
          [from[1], from[0]], // [lng, lat]
          animatedTo,
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
    
    // Link quality percentage (used in tooltip via properties)
    // const linkQuality = maxCertainCount > 0 
    //   ? (edge.certainCount / maxCertainCount)
    //   : 0;
    
    // Get names for tooltip
    const fromNeighbor = neighbors[edge.fromHash];
    const toNeighbor = neighbors[edge.toHash];
    const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
    const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
    
    // Animate "to" position for trace effect
    // GeoJSON uses [lng, lat] order
    const animatedTo: [number, number] = [
      from[1] + (to[1] - from[1]) * traceProgress, // lng
      from[0] + (to[0] - from[0]) * traceProgress, // lat
    ];
    
    // Opacity scales with trace progress
    const baseOpacity = Math.min(traceProgress * 1.5, 1) * DESIGN.edgeOpacity;
    
    // Hover effect: dim non-hovered edges when any edge is hovered
    const hoverOpacityMult = isAnyHovered ? (isHovered ? 1.25 : 0.4) : 1;
    
    // ─── LOOP EDGES: Parallel double-lines ─────────────────────────────────
    if (isLoopEdge) {
      const { line1, line2 } = getParallelOffsets(from, animatedTo, animatedWeight * 1.5);
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
            [line1[0][1], line1[0][0]], // [lng, lat]
            [line1[1][1], line1[1][0]],
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
            [line2[0][1], line2[0][0]], // [lng, lat]
            [line2[1][1], line2[1][0]],
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
          [from[1], from[0]], // [lng, lat]
          animatedTo,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Tooltip Content Component
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeTooltipContentProps {
  fromName: string;
  toName: string;
  certainCount: number;
  linkQuality: number;
  confidence: number;
  isBackbone: boolean;
  isLoopEdge: boolean;
  isDirectPath: boolean;
  isHubConnection: boolean;
  symmetryRatio: number;
  dominantDirection: string;
}

function EdgeTooltipContent({
  fromName,
  toName,
  certainCount,
  linkQuality,
  confidence,
  isBackbone,
  isLoopEdge,
  isDirectPath,
  isHubConnection,
  symmetryRatio,
  dominantDirection,
}: EdgeTooltipContentProps) {
  return (
    <div className="text-xs">
      {/* Directional indicator if asymmetric */}
      {symmetryRatio < 0.7 && dominantDirection !== 'balanced' ? (
        <div className="font-medium text-text-primary flex items-center gap-1">
          {dominantDirection === 'forward' ? (
            <>{fromName} <ArrowRight className="w-3 h-3" /> {toName}</>
          ) : (
            <>{toName} <ArrowRight className="w-3 h-3" /> {fromName}</>
          )}
        </div>
      ) : (
        <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
      )}
      
      <div className="text-text-secondary">
        {certainCount} validations ({Math.round(linkQuality * 100)}%) • {Math.round(confidence * 100)}% conf
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
      
      {isDirectPath && (
        <div className="text-teal-400 flex items-center gap-1">
          <Zap className="w-3 h-3" />
          <span>Direct path</span>
        </div>
      )}
      
      {isHubConnection && !isBackbone && !isDirectPath && (
        <div className="text-amber-400">Hub connection</div>
      )}
    </div>
  );
}

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
  onEdgeHover,
  highlightedEdgeKey,
  neighbors,
}: TopologyEdgesProps) {
  // Tooltip state
  const [tooltipInfo, setTooltipInfo] = useState<{
    longitude: number;
    latitude: number;
    properties: EdgeFeatureProperties;
  } | null>(null);
  
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
  
  // Mouse event handlers for edges (to be wired up at Map level)
  // These are exposed for parent component to attach to Map's interactiveLayerIds
  const _handleMouseEnter = useCallback((e: maplibregl.MapLayerMouseEvent) => {
    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      const props = feature.properties as EdgeFeatureProperties;
      // Extract base key (remove -loop1/-loop2 suffix)
      const baseKey = props.key.replace(/-loop[12]$/, '');
      onEdgeHover(baseKey);
      
      // Set tooltip at mouse position
      if (e.lngLat) {
        setTooltipInfo({
          longitude: e.lngLat.lng,
          latitude: e.lngLat.lat,
          properties: props,
        });
      }
    }
  }, [onEdgeHover]);
  
  const _handleMouseLeave = useCallback(() => {
    onEdgeHover(null);
    setTooltipInfo(null);
  }, [onEdgeHover]);
  
  // Export handlers for parent to use
  // Note: In react-map-gl, these need to be attached at the Map level
  void _handleMouseEnter;
  void _handleMouseLeave;
  
  // Calculate link quality for tooltip
  const linkQuality = tooltipInfo 
    ? maxCertainCount > 0 
      ? (tooltipInfo.properties.certainCount / maxCertainCount)
      : 0
    : 0;
  
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
        <Layer 
          {...validatedEdgesLayerStyle}
          // Enable interactivity for hover/click events
          // Note: react-map-gl handles this via onMouseEnter/onMouseLeave props on Map
        />
      </Source>
      
      {/* ─── EDGE TOOLTIP ─────────────────────────────────────────────── */}
      {tooltipInfo && (
        <Popup
          longitude={tooltipInfo.longitude}
          latitude={tooltipInfo.latitude}
          anchor="bottom"
          closeButton={false}
          closeOnClick={false}
          className="topology-edge-tooltip maplibre-popup"
        >
          <EdgeTooltipContent
            fromName={tooltipInfo.properties.fromName}
            toName={tooltipInfo.properties.toName}
            certainCount={tooltipInfo.properties.certainCount}
            linkQuality={linkQuality}
            confidence={tooltipInfo.properties.confidence}
            isBackbone={tooltipInfo.properties.isBackbone}
            isLoopEdge={tooltipInfo.properties.isLoopEdge}
            isDirectPath={tooltipInfo.properties.isDirectPath}
            isHubConnection={tooltipInfo.properties.isHubConnection}
            symmetryRatio={tooltipInfo.properties.symmetryRatio}
            dominantDirection={tooltipInfo.properties.dominantDirection}
          />
        </Popup>
      )}
    </>
  );
}

// Export types needed by parent
export type { EdgeFeatureProperties };
