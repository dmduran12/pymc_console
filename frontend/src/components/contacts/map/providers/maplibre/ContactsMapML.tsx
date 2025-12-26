/**
 * MapLibre ContactsMap Component
 * 
 * Main map component using MapLibre GL JS.
 * This is a drop-in replacement for the Leaflet ContactsMap.
 * 
 * Features ported from Leaflet version:
 * - Dark OSM tiles (CARTO dark-matter)
 * - Custom node markers with HTML elements
 * - Topology edges with trace animation
 * - Neighbor edges (dashed lines)
 * - Popups and tooltips
 * - Fit bounds on load
 * - Zoom to node
 * - Fullscreen mode
 * - Solo modes (Direct, Hubs)
 * 
 * @module providers/maplibre/ContactsMapML
 */

import { useMemo, useState, useCallback, useRef } from 'react';
import MapGL, { NavigationControl, ScaleControl } from 'react-map-gl/maplibre';
import type { MapRef, ViewStateChangeEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { NeighborInfo } from '@/types/api';
import type { MeshTopology, LastHopNeighbor } from '@/lib/mesh-topology';
import { getLinkQualityWeight } from '@/lib/mesh-topology';

import { useEdgeAnimation } from '../../animations/useEdgeAnimation';
import { useNodeAnimation } from '../../animations/useNodeAnimation';

import { NodeMarkers, type LocalNode } from './NodeMarkers';
import { TopologyEdges, type EdgePolylineData } from './TopologyEdges';
import { NeighborEdges, type NeighborPolylineData } from './NeighborEdges';
import { FitBoundsOnce, ZoomToNode, EdgeHighlighter } from './MapHelpers';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

// CARTO Dark Matter - free dark basemap (no API key required)
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Default view state (world view)
const DEFAULT_VIEW_STATE = {
  longitude: 0,
  latitude: 0,
  zoom: 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ContactsMapMLProps {
  /** Neighbors data from API */
  neighbors: Record<string, NeighborInfo>;
  /** Local node info */
  localNode?: LocalNode;
  /** Local node hash */
  localHash?: string;
  /** Mesh topology data */
  meshTopology: MeshTopology;
  /** Map of last-hop neighbor data */
  lastHopNeighborMap: Map<string, LastHopNeighbor>;
  /** Whether topology view is enabled */
  showTopology: boolean;
  /** Callback to toggle topology */
  onToggleTopology: () => void;
  /** Whether solo direct mode is enabled */
  soloDirect: boolean;
  /** Callback to toggle solo direct */
  onToggleSoloDirect: () => void;
  /** Whether solo hubs mode is enabled */
  soloHubs: boolean;
  /** Callback to toggle solo hubs */
  onToggleSoloHubs: () => void;
  /** Whether fullscreen mode is enabled */
  isFullscreen: boolean;
  /** Callback to toggle fullscreen */
  onToggleFullscreen: () => void;
  /** Target node hash to zoom to */
  zoomToNodeHash?: string | null;
  /** Callback when zoom to node completes */
  onZoomToNodeComplete?: () => void;
  /** Highlighted edge key (from PathHealth panel) */
  highlightedEdgeKey?: string | null;
  /** Callback to ensure topology is visible */
  onEnsureTopology?: () => void;
  /** Callback when remove node is requested */
  onRequestRemove?: (hash: string, name: string) => void;
  /** CSS class name */
  className?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

export function ContactsMapML({
  neighbors,
  localNode,
  localHash,
  meshTopology,
  lastHopNeighborMap,
  showTopology,
  // onToggleTopology, // Control buttons handled by parent
  soloDirect,
  // onToggleSoloDirect, // Control buttons handled by parent
  soloHubs,
  // onToggleSoloHubs, // Control buttons handled by parent
  // isFullscreen, // Control buttons handled by parent
  // onToggleFullscreen, // Control buttons handled by parent
  zoomToNodeHash,
  onZoomToNodeComplete,
  highlightedEdgeKey,
  onEnsureTopology,
  onRequestRemove,
  className,
}: ContactsMapMLProps) {
  const mapRef = useRef<MapRef>(null);
  
  // ─── VIEW STATE ────────────────────────────────────────────────────────────
  const [viewState, setViewState] = useState(DEFAULT_VIEW_STATE);
  
  // ─── HOVER STATE ───────────────────────────────────────────────────────────
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  
  // ─── DERIVED DATA ──────────────────────────────────────────────────────────
  
  // Neighbors with location
  const neighborsWithLocation = useMemo(() => {
    return Object.entries(neighbors).filter(
      ([, n]) => n.latitude && n.longitude
    ) as [string, NeighborInfo][];
  }, [neighbors]);
  
  // All positions for bounds fitting
  const allPositions = useMemo(() => {
    const positions: [number, number][] = [];
    
    if (localNode?.latitude && localNode?.longitude) {
      positions.push([localNode.latitude, localNode.longitude]);
    }
    
    for (const [, neighbor] of neighborsWithLocation) {
      if (neighbor.latitude && neighbor.longitude) {
        positions.push([neighbor.latitude, neighbor.longitude]);
      }
    }
    
    return positions;
  }, [localNode, neighborsWithLocation]);
  
  // Node coordinates map
  const nodeCoordinates = useMemo(() => {
    const coords = new Map<string, [number, number]>();
    
    if (localHash && localNode?.latitude && localNode?.longitude) {
      coords.set(localHash, [localNode.latitude, localNode.longitude]);
    }
    
    for (const [hash, neighbor] of neighborsWithLocation) {
      if (neighbor.latitude && neighbor.longitude) {
        coords.set(hash, [neighbor.latitude, neighbor.longitude]);
      }
    }
    
    return coords;
  }, [localHash, localNode, neighborsWithLocation]);
  
  // Zero-hop neighbors (direct RF contacts)
  // Use lastHopNeighborMap directly - these are neighbors we've received packets from as last hop
  const zeroHopNeighbors = useMemo(() => {
    const zeroHop = new Set<string>();
    for (const hash of lastHopNeighborMap.keys()) {
      if (neighbors[hash]?.latitude && neighbors[hash]?.longitude) {
        zeroHop.add(hash);
      }
    }
    return zeroHop;
  }, [lastHopNeighborMap, neighbors]);
  
  // ─── EDGE POLYLINES ────────────────────────────────────────────────────────
  
  // Validated edges
  const validatedPolylines = useMemo((): EdgePolylineData[] => {
    const lines: EdgePolylineData[] = [];
    
    for (const edge of meshTopology.validatedEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      if (fromCoords && toCoords) {
        lines.push({
          from: fromCoords,
          to: toCoords,
          edge,
        });
      }
    }
    
    return lines;
  }, [meshTopology.validatedEdges, nodeCoordinates]);
  
  // Weak edges
  const weakPolylines = useMemo((): EdgePolylineData[] => {
    const lines: EdgePolylineData[] = [];
    
    for (const edge of meshTopology.weakEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      if (fromCoords && toCoords) {
        lines.push({
          from: fromCoords,
          to: toCoords,
          edge,
        });
      }
    }
    
    return lines;
  }, [meshTopology.weakEdges, nodeCoordinates]);
  
  // Neighbor edges (from local to zero-hop neighbors)
  const neighborPolylines = useMemo((): NeighborPolylineData[] => {
    if (!localNode?.latitude || !localNode?.longitude) return [];
    
    const lines: NeighborPolylineData[] = [];
    const localCoords: [number, number] = [localNode.latitude, localNode.longitude];
    
    for (const hash of zeroHopNeighbors) {
      const neighbor = neighbors[hash];
      if (!neighbor?.latitude || !neighbor?.longitude) continue;
      
      lines.push({
        from: localCoords,
        to: [neighbor.latitude, neighbor.longitude],
        hash,
        neighbor,
        lastHopData: lastHopNeighborMap.get(hash) ?? null,
      });
    }
    
    return lines;
  }, [localNode, zeroHopNeighbors, neighbors, lastHopNeighborMap]);
  
  // ─── LOOP AND BACKBONE EDGES ───────────────────────────────────────────────
  
  const loopEdgeKeys = useMemo(() => new Set(meshTopology.loopEdgeKeys), [meshTopology.loopEdgeKeys]);
  const backboneEdgeKeys = useMemo(() => new Set(meshTopology.backboneEdges), [meshTopology.backboneEdges]);
  
  // ─── MAX CERTAIN COUNT ─────────────────────────────────────────────────────
  
  const maxCertainCount = useMemo(() => {
    let max = 0;
    for (const edge of meshTopology.validatedEdges) {
      if (edge.certainCount > max) max = edge.certainCount;
    }
    return max || 1;
  }, [meshTopology.validatedEdges]);
  
  // ─── ANIMATIONS ────────────────────────────────────────────────────────────
  
  // Edge animation state
  const {
    edgeAnimProgress,
    weightAnimProgress,
    animStartWeights,
    animTargetWeights,
    isExiting,
  } = useEdgeAnimation({
    showTopology,
    polylines: validatedPolylines,
    weakPolylines,
    maxCertainCount,
    getWeight: getLinkQualityWeight,
  });
  
  // Hub-connected nodes (neighbors connected to hubs via topology)
  const hubConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    for (const hubHash of meshTopology.hubNodes) {
      connected.add(hubHash);
      for (const edge of meshTopology.validatedEdges) {
        if (edge.fromHash === hubHash) connected.add(edge.toHash);
        if (edge.toHash === hubHash) connected.add(edge.fromHash);
      }
    }
    return connected;
  }, [meshTopology.hubNodes, meshTopology.validatedEdges]);
  
  // Local-connected nodes (neighbors with topology edges to local)
  const localConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    if (!localHash) return connected;
    for (const edge of meshTopology.validatedEdges) {
      if (edge.fromHash === localHash) connected.add(edge.toHash);
      if (edge.toHash === localHash) connected.add(edge.fromHash);
    }
    return connected;
  }, [localHash, meshTopology.validatedEdges]);
  
  // Node animation state
  const { getNodeOpacity } = useNodeAnimation({
    soloDirect,
    soloHubs,
    neighborHashes: neighborsWithLocation.map(([h]) => h),
    hubConnectedNodes,
    directNodeSet: zeroHopNeighbors,
    localConnectedNodes,
    showTopology,
  });
  
  // ─── VISIBILITY LOGIC ──────────────────────────────────────────────────────
  
  const shouldShowNode = useCallback((hash: string): boolean => {
    // If neither solo mode is active, show all nodes
    if (!soloDirect && !soloHubs) return true;
    
    // Solo Direct: only show zero-hop neighbors
    if (soloDirect) {
      return zeroHopNeighbors.has(hash);
    }
    
    // Solo Hubs: only show hub nodes and their connected neighbors
    if (soloHubs) {
      if (meshTopology.hubNodes.includes(hash)) return true;
      
      // Show neighbors connected to hubs
      for (const edge of meshTopology.validatedEdges) {
        if (edge.fromHash === hash && meshTopology.hubNodes.includes(edge.toHash)) return true;
        if (edge.toHash === hash && meshTopology.hubNodes.includes(edge.fromHash)) return true;
      }
      
      return false;
    }
    
    return true;
  }, [soloDirect, soloHubs, zeroHopNeighbors, meshTopology.hubNodes, meshTopology.validatedEdges]);
  
  // ─── EVENT HANDLERS ────────────────────────────────────────────────────────
  
  const handleViewStateChange = useCallback((e: ViewStateChangeEvent) => {
    setViewState(e.viewState);
  }, []);
  
  const handleEnsureTopology = useCallback(() => {
    if (!showTopology && onEnsureTopology) {
      onEnsureTopology();
    }
  }, [showTopology, onEnsureTopology]);
  
  // ─── RENDER ────────────────────────────────────────────────────────────────
  
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MapGL
        ref={mapRef}
        {...viewState}
        onMove={handleViewStateChange}
        mapStyle={MAP_STYLE}
        style={{ width: '100%', height: '100%' }}
        attributionControl={false}
      >
        {/* ─── NAVIGATION CONTROLS ─────────────────────────────────────────── */}
        <NavigationControl position="top-right" />
        <ScaleControl position="bottom-right" />
        
        {/* ─── FIT BOUNDS ON LOAD ──────────────────────────────────────────── */}
        <FitBoundsOnce positions={allPositions} />
        
        {/* ─── ZOOM TO NODE ────────────────────────────────────────────────── */}
        {zoomToNodeHash && (
          <ZoomToNode
            targetHash={zoomToNodeHash}
            nodeCoordinates={nodeCoordinates}
            onComplete={onZoomToNodeComplete}
          />
        )}
        
        {/* ─── EDGE HIGHLIGHTER ────────────────────────────────────────────── */}
        {highlightedEdgeKey && (
          <EdgeHighlighter
            highlightedEdgeKey={highlightedEdgeKey}
            validatedPolylines={validatedPolylines}
            weakPolylines={weakPolylines}
            onEnsureTopology={handleEnsureTopology}
          />
        )}
        
        {/* ─── NEIGHBOR EDGES (always visible) ─────────────────────────────── */}
        <NeighborEdges
          neighborPolylines={neighborPolylines}
          hoveredEdgeKey={hoveredEdgeKey}
          onEdgeHover={setHoveredEdgeKey}
        />
        
        {/* ─── TOPOLOGY EDGES ──────────────────────────────────────────────── */}
        <TopologyEdges
          showTopology={showTopology}
          isExiting={isExiting}
          validatedPolylines={validatedPolylines}
          weakPolylines={weakPolylines}
          edgeAnimProgress={edgeAnimProgress}
          weightAnimProgress={weightAnimProgress}
          animStartWeights={animStartWeights}
          animTargetWeights={animTargetWeights}
          maxCertainCount={maxCertainCount}
          loopEdgeKeys={loopEdgeKeys}
          backboneEdgeKeys={backboneEdgeKeys}
          hoveredEdgeKey={hoveredEdgeKey}
          onEdgeHover={setHoveredEdgeKey}
          highlightedEdgeKey={highlightedEdgeKey}
          neighbors={neighbors}
        />
        
        {/* ─── NODE MARKERS ────────────────────────────────────────────────── */}
        <NodeMarkers
          neighborsWithLocation={neighborsWithLocation}
          localNode={localNode}
          localHash={localHash}
          zeroHopNeighbors={zeroHopNeighbors}
          lastHopNeighborMap={lastHopNeighborMap}
          meshTopology={meshTopology}
          hoveredMarker={hoveredMarker}
          onMarkerHover={setHoveredMarker}
          getNodeOpacity={getNodeOpacity}
          shouldShowNode={shouldShowNode}
          onRequestRemove={onRequestRemove}
        />
      </MapGL>
    </div>
  );
}
