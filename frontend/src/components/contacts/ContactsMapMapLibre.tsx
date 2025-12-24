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
import MapGL, { NavigationControl, ScaleControl } from 'react-map-gl/maplibre';
import type { MapRef, ViewStateChangeEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Maximize2, Minimize2, Network, GitBranch, Radio, BarChart2, Loader2 } from 'lucide-react';
import clsx from 'clsx';

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

import { useEdgeAnimation } from './map/animations/useEdgeAnimation';
import { useNodeAnimation } from './map/animations/useNodeAnimation';

import {
  NodeMarkers,
  TopologyEdges,
  NeighborEdges,
  FitBoundsOnce,
  ZoomToNode,
  EdgeHighlighter,
  type EdgePolylineData,
  type NeighborPolylineData,
  type LocalNode,
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
  
  // Track if deep analysis has completed (for button state)
  const hasDeepLoaded = packetCacheState.backgroundLoadComplete;
  
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
  
  // ─── DERIVED DATA ──────────────────────────────────────────────────────────
  
  // Neighbors with location
  const neighborsWithLocation = useMemo(() => {
    return Object.entries(neighbors).filter(
      ([_, n]) => n.latitude && n.longitude
    ) as [string, NeighborInfo][];
  }, [neighbors]);
  
  // All positions for bounds fitting
  const allPositions = useMemo(() => {
    const positions: [number, number][] = [];
    
    if (localNode?.latitude && localNode?.longitude) {
      positions.push([localNode.latitude, localNode.longitude]);
    }
    
    for (const [_, neighbor] of neighborsWithLocation) {
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
        >
          <NavigationControl position="top-right" />
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
        </MapGL>
        
        {/* ─── MAP CONTROLS (inline overlay) ───────────────────────────────── */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          {/* Fullscreen toggle */}
          <button
            onClick={handleToggleFullscreen}
            className="p-2 rounded-lg bg-surface/80 backdrop-blur-sm border border-white/10 hover:bg-surface/90 transition-colors"
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4 text-text-secondary" />
            ) : (
              <Maximize2 className="w-4 h-4 text-text-secondary" />
            )}
          </button>
          
          {/* Topology toggle */}
          <button
            onClick={handleToggleTopology}
            className={clsx(
              'p-2 rounded-lg backdrop-blur-sm border transition-colors',
              showTopology
                ? 'bg-[#4338CA]/20 border-[#4338CA]/40 text-[#4338CA]'
                : 'bg-surface/80 border-white/10 text-text-secondary hover:bg-surface/90'
            )}
            title={showTopology ? 'Hide topology' : 'Show topology'}
          >
            <GitBranch className="w-4 h-4" />
          </button>
          
          {/* Solo Direct toggle */}
          <button
            onClick={handleToggleSoloDirect}
            className={clsx(
              'p-2 rounded-lg backdrop-blur-sm border transition-colors',
              soloDirect
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                : 'bg-surface/80 border-white/10 text-text-secondary hover:bg-surface/90'
            )}
            title={soloDirect ? 'Show all nodes' : 'Show direct neighbors only'}
          >
            <Radio className="w-4 h-4" />
          </button>
          
          {/* Solo Hubs toggle */}
          <button
            onClick={handleToggleSoloHubs}
            className={clsx(
              'p-2 rounded-lg backdrop-blur-sm border transition-colors',
              soloHubs
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                : 'bg-surface/80 border-white/10 text-text-secondary hover:bg-surface/90'
            )}
            title={soloHubs ? 'Show all nodes' : 'Show hub connections only'}
          >
            <Network className="w-4 h-4" />
          </button>
          
          {/* Deep Analysis button */}
          <button
            onClick={handleDeepAnalysis}
            disabled={isDeepLoading}
            className={clsx(
              'p-2 rounded-lg backdrop-blur-sm border transition-colors',
              hasDeepLoaded
                ? 'bg-accent-success/20 border-accent-success/40 text-accent-success'
                : 'bg-surface/80 border-white/10 text-text-secondary hover:bg-surface/90',
              isDeepLoading && 'opacity-50 cursor-not-allowed'
            )}
            title={hasDeepLoaded ? 'Deep analysis complete' : 'Run deep analysis'}
          >
            {isDeepLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <BarChart2 className="w-4 h-4" />
            )}
          </button>
        </div>
        
        {/* ─── LEGEND (bottom-left) ─────────────────────────────────────────── */}
        {showTopology && (
          <div className="absolute bottom-3 left-3 z-10 p-2 rounded-lg bg-surface/80 backdrop-blur-sm border border-white/10 text-[10px] text-text-muted">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-[#3B3F4A]" />
                <span>Topology</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5" style={{ background: '#FBBF24', opacity: 0.6 }} />
                <span>Direct</span>
              </span>
            </div>
          </div>
        )}
      </div>
      
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
