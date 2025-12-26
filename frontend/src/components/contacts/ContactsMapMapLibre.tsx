/**
 * ContactsMapMapLibre
 * 
 * MapLibre GL JS version of the ContactsMap component.
 * Standalone component that internally manages all state (topology, animations, etc.)
 * Same props interface as the Leaflet version for drop-in replacement.
 * 
 * @module ContactsMapMapLibre
 */

import { useMemo, useState, useCallback, useRef } from 'react';
import MapGL, { NavigationControl, ScaleControl, Popup } from 'react-map-gl/maplibre';
import type { MapRef, ViewStateChangeEvent, MapLayerMouseEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { NeighborInfo } from '@/types/api';
import type { LastHopNeighbor } from '@/lib/mesh-topology';
import { getLinkQualityWeight } from '@/lib/mesh-topology';
import { useTopology } from '@/lib/stores/useTopologyStore';
import { useTriggerDeepAnalysis, useQuickNeighbors, usePacketCacheState } from '@/lib/stores/useStore';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DeepAnalysisModal } from '@/components/ui/DeepAnalysisModal';
import {
  MIN_BUILDING_TIME_MS,
  READY_DISPLAY_TIME_MS,
  POST_MODAL_ANIMATION_DELAY_MS,
} from './map/constants';
import { MapLegend } from './map/overlays/MapLegend';
import { MapControls } from './map/overlays/MapControls';

import { useEdgeAnimation } from './map/animations/useEdgeAnimation';
import { useNodeAnimation } from './map/animations/useNodeAnimation';

import {
  NodeMarkers,
  TopologyEdges,
  NeighborEdges,
  FitBoundsOnce,
  ZoomToNode,
  EdgeHighlighter,
  TOPOLOGY_EDGE_LAYER_IDS,
  NEIGHBOR_EDGE_LAYER_IDS,
  type EdgePolylineData,
  type NeighborPolylineData,
  type LocalNode,
  type EdgeFeatureProperties,
  type NeighborEdgeProperties,
} from './map/providers/maplibre';

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

interface ContactsMapProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
  localHash?: string;
  onRemoveNode?: (hash: string) => void;
  selectedNodeHash?: string | null;
  onNodeSelected?: () => void;
  highlightedEdgeKey?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Tooltip Content
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeTooltipContentProps {
  type: 'topology' | 'neighbor';
  properties: EdgeFeatureProperties | NeighborEdgeProperties;
  maxCertainCount: number;
}

/**
 * Unified tooltip content for both topology and neighbor edges.
 * Rendered at map level for proper interactivity with hit-area layers.
 */
function EdgeTooltipContent({ type, properties, maxCertainCount }: EdgeTooltipContentProps) {
  if (type === 'neighbor') {
    const props = properties as NeighborEdgeProperties;
    return (
      <div className="text-xs">
        <div className="font-medium text-text-primary">
          <span className="text-amber-400">●</span> {props.name}
          {props.prefix && (
            <span className="ml-1 text-text-muted font-mono text-[10px]">
              ({props.prefix})
            </span>
          )}
        </div>
        <div className="text-text-secondary flex gap-2">
          {props.rssi !== undefined && props.rssi !== null && (
            <span>RSSI: {Math.round(props.rssi)} dBm{props.hasAvgRssi && ' avg'}</span>
          )}
          {props.snr !== undefined && props.snr !== null && (
            <span>SNR: {Number(props.snr).toFixed(1)} dB{props.hasAvgSnr && ' avg'}</span>
          )}
        </div>
        {props.packetCount !== undefined && (
          <div className="text-text-muted text-[10px]">
            {Number(props.packetCount).toLocaleString()} packets
            {props.confidence !== undefined && ` • ${Math.round(Number(props.confidence) * 100)}% conf`}
          </div>
        )}
        <div className="text-amber-400 text-[10px] mt-0.5">Direct RF neighbor</div>
      </div>
    );
  }
  
  // Topology edge
  const props = properties as EdgeFeatureProperties;
  const linkQuality = maxCertainCount > 0 ? (Number(props.certainCount) / maxCertainCount) : 0;
  
  return (
    <div className="text-xs">
      <div className="font-medium text-text-primary">
        {props.fromName} ↔ {props.toName}
      </div>
      <div className="text-text-secondary">
        {props.certainCount} validations ({Math.round(linkQuality * 100)}%) • {Math.round(Number(props.confidence) * 100)}% conf
      </div>
      {props.isBackbone && (
        <div className="text-gray-300 font-semibold">Backbone</div>
      )}
      {props.isLoopEdge && (
        <div className="text-indigo-400 text-[10px] mt-0.5">Redundant path</div>
      )}
      {props.isDirectPath && (
        <div className="text-teal-400 text-[10px]">Direct path</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

export default function ContactsMapMapLibre({
  neighbors,
  localNode,
  localHash,
  onRemoveNode,
  selectedNodeHash,
  onNodeSelected,
  highlightedEdgeKey,
}: ContactsMapProps) {
  const mapRef = useRef<MapRef>(null);
  
  // ─── GLOBAL STATE ──────────────────────────────────────────────────────────
  const meshTopology = useTopology();
  const triggerDeepAnalysis = useTriggerDeepAnalysis();
  const quickNeighbors = useQuickNeighbors();
  const packetCacheState = usePacketCacheState();
  
  
  // ─── LOCAL STATE ───────────────────────────────────────────────────────────
  const [viewState, setViewState] = useState(DEFAULT_VIEW_STATE);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [soloDirect, setSoloDirect] = useState(false);
  const [soloHubs, setSoloHubs] = useState(false);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  
  // ─── MODAL STATE ───────────────────────────────────────────────────────────
  const [removeConfirmHash, setRemoveConfirmHash] = useState<string | null>(null);
  const [removeConfirmName, setRemoveConfirmName] = useState<string>('');
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<'fetching' | 'analyzing' | 'building' | 'complete'>('fetching');
  const [isDeepLoading, setIsDeepLoading] = useState(false);
  const [deepPacketCount, setDeepPacketCount] = useState(0);
  
  // ─── EDGE TOOLTIP STATE (managed at map level for interactivity) ────────────
  const [edgeTooltip, setEdgeTooltip] = useState<{
    longitude: number;
    latitude: number;
    type: 'topology' | 'neighbor';
    properties: EdgeFeatureProperties | NeighborEdgeProperties;
  } | null>(null);
  
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
  
  // Build lastHopNeighborMap from quickNeighbors and topology
  const lastHopNeighborMap = useMemo(() => {
    const map = new Map<string, LastHopNeighbor>();
    
    // Primary source: quickNeighbors (from polling)
    for (const qn of quickNeighbors) {
      map.set(qn.hash, {
        hash: qn.hash,
        prefix: qn.prefix,
        count: qn.count,
        avgRssi: qn.avgRssi,
        avgSnr: qn.avgSnr,
        lastSeen: qn.lastSeen,
        confidence: 1.0,
      });
    }
    
    // Merge: topology lastHopNeighbors (after deep analysis)
    // Note: lastHopNeighbors is an array, not a Map
    for (const lastHop of meshTopology.lastHopNeighbors) {
      if (!map.has(lastHop.hash)) {
        map.set(lastHop.hash, lastHop);
      }
    }
    
    return map;
  }, [quickNeighbors, meshTopology.lastHopNeighbors]);
  
  // Zero-hop neighbors (direct RF contacts)
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
  
  const validatedPolylines = useMemo((): EdgePolylineData[] => {
    const lines: EdgePolylineData[] = [];
    
    for (const edge of meshTopology.validatedEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      if (fromCoords && toCoords) {
        lines.push({ from: fromCoords, to: toCoords, edge });
      }
    }
    
    return lines;
  }, [meshTopology.validatedEdges, nodeCoordinates]);
  
  const weakPolylines = useMemo((): EdgePolylineData[] => {
    const lines: EdgePolylineData[] = [];
    
    for (const edge of meshTopology.weakEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      if (fromCoords && toCoords) {
        lines.push({ from: fromCoords, to: toCoords, edge });
      }
    }
    
    return lines;
  }, [meshTopology.weakEdges, nodeCoordinates]);
  
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
  
  const {
    edgeAnimProgress,
    weightAnimProgress,
    animStartWeights,
    animTargetWeights,
    isExiting,
    resetAnimationState,
  } = useEdgeAnimation({
    showTopology,
    polylines: validatedPolylines,
    weakPolylines,
    maxCertainCount,
    getWeight: getLinkQualityWeight,
  });
  
  // Hub-connected nodes
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
  
  // Local-connected nodes
  const localConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    if (!localHash) return connected;
    for (const edge of meshTopology.validatedEdges) {
      if (edge.fromHash === localHash) connected.add(edge.toHash);
      if (edge.toHash === localHash) connected.add(edge.fromHash);
    }
    return connected;
  }, [localHash, meshTopology.validatedEdges]);
  
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
    if (!soloDirect && !soloHubs) return true;
    
    if (soloDirect) {
      return zeroHopNeighbors.has(hash);
    }
    
    if (soloHubs) {
      if (meshTopology.hubNodes.includes(hash)) return true;
      for (const edge of meshTopology.validatedEdges) {
        if (edge.fromHash === hash && meshTopology.hubNodes.includes(edge.toHash)) return true;
        if (edge.toHash === hash && meshTopology.hubNodes.includes(edge.fromHash)) return true;
      }
      return false;
    }
    
    return true;
  }, [soloDirect, soloHubs, zeroHopNeighbors, meshTopology.hubNodes, meshTopology.validatedEdges]);
  
  // ─── DEEP ANALYSIS ─────────────────────────────────────────────────────────
  
  const handleDeepAnalysis = useCallback(async () => {
    setIsDeepLoading(true);
    setShowAnalysisModal(true);
    setAnalysisStep('fetching');
    setDeepPacketCount(0);
    
    // Start fetching
    await triggerDeepAnalysis();
    
    // Update packet count from cache state
    setDeepPacketCount(packetCacheState.packetCount);
    
    // Brief analyzing step
    setAnalysisStep('analyzing');
    await new Promise(r => setTimeout(r, 200));
    
    // Building topology
    setAnalysisStep('building');
    const buildingStartTime = Date.now();
    
    // Wait for minimum building time
    const elapsed = Date.now() - buildingStartTime;
    if (elapsed < MIN_BUILDING_TIME_MS) {
      await new Promise(r => setTimeout(r, MIN_BUILDING_TIME_MS - elapsed));
    }
    
    // Show complete state
    setAnalysisStep('complete');
    await new Promise(r => setTimeout(r, READY_DISPLAY_TIME_MS));
    
    // Close modal and enable topology
    setShowAnalysisModal(false);
    setIsDeepLoading(false);
    resetAnimationState();
    
    setTimeout(() => {
      setShowTopology(true);
    }, POST_MODAL_ANIMATION_DELAY_MS);
  }, [triggerDeepAnalysis, resetAnimationState, packetCacheState.packetCount]);
  
  // ─── EVENT HANDLERS ────────────────────────────────────────────────────────
  
  const handleViewStateChange = useCallback((e: ViewStateChangeEvent) => {
    setViewState(e.viewState);
  }, []);
  
  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);
  
  const handleToggleTopology = useCallback(() => {
    setShowTopology(prev => !prev);
  }, []);
  
  const handleToggleSoloDirect = useCallback(() => {
    setSoloDirect(prev => !prev);
  }, []);
  
  const handleToggleSoloHubs = useCallback(() => {
    setSoloHubs(prev => !prev);
  }, []);
  
  const handleEnsureTopology = useCallback(() => {
    if (!showTopology) {
      setShowTopology(true);
    }
  }, [showTopology]);
  
  const handleRequestRemove = useCallback((hash: string, name: string) => {
    setRemoveConfirmHash(hash);
    setRemoveConfirmName(name);
  }, []);
  
  const handleConfirmRemove = useCallback(() => {
    if (removeConfirmHash && onRemoveNode) {
      onRemoveNode(removeConfirmHash);
    }
    setRemoveConfirmHash(null);
    setRemoveConfirmName('');
  }, [removeConfirmHash, onRemoveNode]);
  
  // ─── EDGE INTERACTION HANDLERS (for interactiveLayerIds) ──────────────────
  
  // Combine layer IDs for interactivity
  const interactiveLayerIds = useMemo(() => [
    ...TOPOLOGY_EDGE_LAYER_IDS,
    ...NEIGHBOR_EDGE_LAYER_IDS,
  ], []);
  
  // Handle edge mouse move for hover state and tooltip
  const handleEdgeMouseMove = useCallback((e: MapLayerMouseEvent) => {
    if (!e.features || e.features.length === 0) return;
    
    const feature = e.features[0];
    const layerId = feature.layer?.id;
    const props = feature.properties;
    
    if (!props?.key) return;
    
    // Determine if topology edge or neighbor edge
    const isTopologyEdge = layerId?.startsWith('topology-');
    const isNeighborEdge = layerId?.startsWith('neighbor-');
    
    if (isTopologyEdge || isNeighborEdge) {
      // Extract base key (remove -loop1/-loop2 suffix for topology)
      const baseKey = props.key.replace(/-loop[12]$/, '');
      setHoveredEdgeKey(baseKey);
      
      // Update tooltip position
      if (e.lngLat) {
        setEdgeTooltip({
          longitude: e.lngLat.lng,
          latitude: e.lngLat.lat,
          type: isTopologyEdge ? 'topology' : 'neighbor',
          properties: props as EdgeFeatureProperties | NeighborEdgeProperties,
        });
      }
    }
    
    // Change cursor to pointer over edges
    if (mapRef.current) {
      mapRef.current.getCanvas().style.cursor = 'pointer';
    }
  }, []);
  
  // Handle edge mouse leave
  const handleEdgeMouseLeave = useCallback(() => {
    setHoveredEdgeKey(null);
    setEdgeTooltip(null);
    
    // Reset cursor
    if (mapRef.current) {
      mapRef.current.getCanvas().style.cursor = '';
    }
  }, []);
  
  // ─── RENDER ────────────────────────────────────────────────────────────────
  
  const containerHeight = isFullscreen ? 'h-screen' : 'h-[500px]';
  const containerClass = isFullscreen 
    ? 'fixed inset-0 z-50 bg-surface' 
    : 'glass-card overflow-hidden';
  
  return (
    <div className={`${containerClass} ${containerHeight}`}>
      <div className="relative w-full h-full">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={handleViewStateChange}
          mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
          // Interactive layers for edge hover/click
          interactiveLayerIds={interactiveLayerIds}
          onMouseMove={handleEdgeMouseMove}
          onMouseLeave={handleEdgeMouseLeave}
          // Darken map labels and use Inter font to match app
          onLoad={(e) => {
            const map = e.target;
            const style = map.getStyle();
            if (style?.layers) {
              for (const layer of style.layers) {
                if (layer.type === 'symbol') {
                  // Darken all text to ~20% gray (very subtle, matches dark map aesthetic)
                  map.setPaintProperty(layer.id, 'text-color', 'rgba(50, 52, 58, 1)');
                  // Darken halo to near-black for subtle contrast
                  map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(8, 9, 11, 0.9)');
                  map.setPaintProperty(layer.id, 'text-halo-width', 1);
                  // Use Inter font (app's display font) with fallbacks
                  map.setLayoutProperty(layer.id, 'text-font', ['Inter', 'Open Sans Regular', 'Arial Unicode MS Regular']);
                }
              }
            }
          }}
        >
          <NavigationControl position="top-left" style={{ marginTop: '1rem', marginLeft: '1rem' }} />
          <ScaleControl position="bottom-right" />
          
          <FitBoundsOnce positions={allPositions} />
          
          {selectedNodeHash && (
            <ZoomToNode
              targetHash={selectedNodeHash}
              nodeCoordinates={nodeCoordinates}
              onComplete={onNodeSelected}
            />
          )}
          
          {highlightedEdgeKey && (
            <EdgeHighlighter
              highlightedEdgeKey={highlightedEdgeKey}
              validatedPolylines={validatedPolylines}
              weakPolylines={weakPolylines}
              onEnsureTopology={handleEnsureTopology}
            />
          )}
          
          <NeighborEdges
            neighborPolylines={neighborPolylines}
            hoveredEdgeKey={hoveredEdgeKey}
            onEdgeHover={setHoveredEdgeKey}
          />
          
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
            onRequestRemove={onRemoveNode ? handleRequestRemove : undefined}
          />
          
          {/* ─── EDGE TOOLTIP (rendered at map level for interactivity) ─────────── */}
          {/* Offset upward to avoid cursor overlap and allow easy hover-off */}
          {edgeTooltip && (
            <Popup
              longitude={edgeTooltip.longitude}
              latitude={edgeTooltip.latitude}
              anchor="bottom"
              offset={[0, -20] as [number, number]}
              closeButton={false}
              closeOnClick={false}
              className="maplibre-popup"
            >
              <EdgeTooltipContent
                type={edgeTooltip.type}
                properties={edgeTooltip.properties}
                maxCertainCount={maxCertainCount}
              />
            </Popup>
          )}
        </MapGL>
        
        {/* ─── MAP CONTROLS (top-right) ─────────────────────────────────────── */}
        <MapControls
          isDeepLoading={isDeepLoading}
          showDeepAnalysisModal={showAnalysisModal}
          onDeepAnalysis={handleDeepAnalysis}
          showTopology={showTopology}
          onToggleTopology={handleToggleTopology}
          hasValidatedPolylines={validatedPolylines.length > 0}
          soloHubs={soloHubs}
          onToggleSoloHubs={handleToggleSoloHubs}
          hasHubNodes={meshTopology.hubNodes.length > 0}
          soloDirect={soloDirect}
          onToggleSoloDirect={handleToggleSoloDirect}
          hasZeroHopNeighbors={zeroHopNeighbors.size > 0}
          isFullscreen={isFullscreen}
          onToggleFullscreen={handleToggleFullscreen}
        />
        
        {/* ─── LEGEND (bottom-left) ─────────────────────────────────────────── */}
        <MapLegend
          showTopology={showTopology}
          validatedPolylineCount={validatedPolylines.length}
          filteredNeighborCount={neighborsWithLocation.length}
          hasLocalNode={!!(localNode?.latitude && localNode?.longitude)}
          meshTopology={meshTopology}
          zeroHopNeighbors={zeroHopNeighbors}
          neighborsWithLocation={neighborsWithLocation}
        />
      </div>
      
      {/* ─── LIQUID GLASS OVERLAY EFFECTS ──────────────────────────────────────── */}
      {/* Rendered AFTER map for proper stacking, only when not fullscreen */}
      {!isFullscreen && (
        <div className="absolute inset-0 pointer-events-none rounded-[1.125rem] overflow-hidden">
          {/* Top edge highlight */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          {/* Corner accents */}
          <div className="absolute top-0 left-0 w-24 h-24 bg-gradient-to-br from-white/[0.03] to-transparent" />
          <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-white/[0.03] to-transparent" />
          {/* Bottom edge fade */}
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-black/20 to-transparent" />
        </div>
      )}
      
      {/* ─── MODALS ─────────────────────────────────────────────────────────── */}
      <ConfirmModal
        isOpen={removeConfirmHash !== null}
        onCancel={() => setRemoveConfirmHash(null)}
        onConfirm={handleConfirmRemove}
        title="Remove Node?"
        message={`Remove "${removeConfirmName}" from the contacts list? This will hide the node until it sends a new packet.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
      />
      
      <DeepAnalysisModal
        isOpen={showAnalysisModal}
        currentStep={analysisStep}
        packetCount={deepPacketCount}
      />
    </div>
  );
}
