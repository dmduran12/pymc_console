import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Map as MapLibreMap, MapRef, useControl, Popup } from 'react-map-gl/maplibre';
import type { StyleSpecification, MapLibreEvent } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, ArcLayer } from '@deck.gl/layers';
import type { MapboxOverlayProps } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { GitBranch, Network, Radio, Box, Map as MapIcon, Maximize2, Minimize2, Home, MessageCircle, Info, BarChart2 } from 'lucide-react';
import { DeepAnalysisModal, type AnalysisStep } from '@/components/ui/DeepAnalysisModal';
import { usePacketCacheState, useTriggerDeepAnalysis } from '@/lib/stores/useStore';
import { useIsComputingTopology } from '@/lib/stores/useTopologyStore';
import 'maplibre-gl/dist/maplibre-gl.css';
import { NeighborInfo } from '@/types/api';
import { useTopology } from '@/lib/stores/useTopologyStore';
import type { TopologyEdge } from '@/lib/stores/useTopologyStore';

// ═══════════════════════════════════════════════════════════════════════════════
// Design System Constants
// ═══════════════════════════════════════════════════════════════════════════════

export const DESIGN = {
  nodeColor: '#4338CA',
  localColor: '#FBBF24',
  hubColor: '#6366F1',
  mobileColor: '#F97316',
  roomServerColor: '#F59E0B',
  edges: {
    backbone: '#6B7280',
    standard: '#4B5563',
    weak: '#374151',
    direct: '#5EEAD4',
    loop: '#6366F1',
  },
  edgeOpacity: 0.82,
};

// Animation timing constants
const ANIMATION = {
  edgeFadeIn: 800,      // ms - edge fade-in duration
  edgeFadeOut: 300,     // ms - edge fade-out duration  
  colorTransition: 200, // ms - deck.gl color transition
  elevationDelay: 500,  // ms - delay for terrain elevation query
  deepAnalysisMinBuild: 1700,  // ms - minimum building step display
  deepAnalysisReady: 1000,     // ms - ready state display time
};

// Fullscreen API type augmentation (vendor prefixes)
type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void>;
  msExitFullscreen?: () => void;
  webkitFullscreenElement?: Element;
  msFullscreenElement?: Element;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
  msRequestFullscreen?: () => void;
};

// ═══════════════════════════════════════════════════════════════════════════════
// Map Style Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MapLibre style with dark theme + 3D terrain support.
 * Uses free tile providers:
 * - CARTO Dark Matter for base map (no API key)
 * - MapLibre demo terrain tiles for elevation (no API key)
 */
const createMapStyle = (): StyleSpecification => ({
  version: 8,
  name: 'pyMC Console - Dark',
  sources: {
    // Base map - CARTO Dark Matter (free, no key required)
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    // Terrain DEM - MapLibre demo tiles (free, no key required)
    terrain: {
      type: 'raster-dem',
      tiles: ['https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.webp'],
      tileSize: 256,
      maxzoom: 14,
      encoding: 'terrarium', // MapLibre demo tiles use Terrarium encoding
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#08090B', // Matches --bg-body from design system
      },
    },
    {
      id: 'carto-base',
      type: 'raster',
      source: 'carto',
      minzoom: 0,
      maxzoom: 22,
    },
  ],
  // 3D terrain configuration (enabled by default)
  terrain: {
    source: 'terrain',
    exaggeration: 1.5, // 1.5x vertical exaggeration for visibility
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// deck.gl Overlay Hook
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DeckGL overlay component using MapboxOverlay for MapLibre integration.
 * Uses interleaved rendering for proper 3D z-ordering with terrain.
 */
function DeckGLOverlay(props: MapboxOverlayProps & { interleaved?: boolean }) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

/** Node data for deck.gl ScatterplotLayer */
interface NodeData {
  hash: string;
  position: [number, number, number]; // [lng, lat, elevation]
  name: string;
  isHub: boolean;
  isMobile: boolean;
  isRoomServer: boolean;
  isLocal: boolean;
  color: [number, number, number, number]; // RGBA
  radius: number;
}

/** Edge data for deck.gl ArcLayer */
interface EdgeData {
  key: string;
  sourcePosition: [number, number, number]; // [lng, lat, elevation]
  targetPosition: [number, number, number];
  sourceColor: [number, number, number, number];
  targetColor: [number, number, number, number];
  width: number;
  edge: TopologyEdge;
}

interface ContactsMap3DProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
  localHash?: string;
  highlightedEdgeKey?: string | null;
  // Future: onRemoveNode, selectedNodeHash, onNodeSelected
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert hex color to RGBA array */
function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [128, 128, 128, alpha];
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
    alpha,
  ];
}

/** Get node color based on type */
function getNodeColor(
  isLocal: boolean,
  isHub: boolean,
  isMobile: boolean,
  isRoomServer: boolean
): [number, number, number, number] {
  if (isLocal) return hexToRgba(DESIGN.localColor);
  if (isRoomServer) return hexToRgba(DESIGN.roomServerColor);
  if (isHub) return hexToRgba(DESIGN.hubColor);
  if (isMobile) return hexToRgba(DESIGN.mobileColor);
  return hexToRgba(DESIGN.nodeColor);
}

/** Get edge color based on confidence and type */
function getEdgeColor(
  confidence: number,
  isBackbone: boolean,
  isDirectPath: boolean
): [number, number, number, number] {
  const alpha = Math.round(DESIGN.edgeOpacity * 255);
  
  if (isDirectPath) {
    return hexToRgba(DESIGN.edges.direct, alpha);
  }
  if (isBackbone) {
    return hexToRgba(DESIGN.edges.backbone, alpha);
  }
  if (confidence >= 0.7) {
    return hexToRgba(DESIGN.edges.standard, alpha);
  }
  return hexToRgba(DESIGN.edges.weak, alpha);
}

/** Calculate edge width based on validation count */
function getEdgeWidth(certainCount: number, maxCount: number): number {
  if (maxCount === 0) return 2;
  // Scale from 2px (min) to 8px (max)
  const normalized = certainCount / maxCount;
  return 2 + normalized * 6;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

export function ContactsMap3D({
  neighbors,
  localNode,
  localHash,
  highlightedEdgeKey,
}: ContactsMap3DProps) {
  const mapRef = useRef<MapRef>(null);
  const meshTopology = useTopology();
  
  // View state with 3D defaults
  const [viewState, setViewState] = useState({
    longitude: localNode?.longitude || -117.5,
    latitude: localNode?.latitude || 34.0,
    zoom: 9,
    pitch: 45, // Tilt for 3D view
    bearing: 0,
  });
  
  // Terrain mode state (3D perspective vs flat)
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [showTopology, setShowTopology] = useState(true);
  const [soloHubs, setSoloHubs] = useState(false);
  const [soloDirect, setSoloDirect] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<NodeData | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeData | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Edge animation state - tracks opacity for fade-in effect
  const [edgeOpacity, setEdgeOpacity] = useState(1);
  const prevShowTopologyRef = useRef(showTopology);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  
  // Elevation cache - stores terrain elevation for each node position
  const [elevationCache, setElevationCache] = useState<Map<string, number>>(new Map());
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Deep Analysis System
  // ─────────────────────────────────────────────────────────────────────────────
  const packetCacheState = usePacketCacheState();
  const isComputingTopology = useIsComputingTopology();
  const triggerDeepAnalysis = useTriggerDeepAnalysis();
  
  const [showDeepAnalysisModal, setShowDeepAnalysisModal] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<AnalysisStep>('fetching');
  const wasDeepLoadingRef = useRef(false);
  const wasComputingRef = useRef(false);
  const buildingStartTimeRef = useRef<number>(0);
  
  const isDeepLoading = packetCacheState.isDeepLoading;
  
  // Derive analysis step from packet cache and topology states
  useEffect(() => {
    if (!showDeepAnalysisModal) return;
    
    if (wasDeepLoadingRef.current && !isDeepLoading) {
      setAnalysisStep('analyzing');
      setTimeout(() => {
        setAnalysisStep('building');
        buildingStartTimeRef.current = Date.now();
      }, ANIMATION.colorTransition + 100);
    }
    
    if (analysisStep === 'building' && !isComputingTopology && buildingStartTimeRef.current > 0) {
      const elapsed = Date.now() - buildingStartTimeRef.current;
      const remainingDelay = Math.max(0, ANIMATION.deepAnalysisMinBuild - elapsed);
      
      buildingStartTimeRef.current = 0;
      
      setTimeout(() => {
        setAnalysisStep('complete');
        setTimeout(() => {
          setShowDeepAnalysisModal(false);
          setAnalysisStep('fetching');
          setShowTopology(true);
        }, ANIMATION.deepAnalysisReady);
      }, remainingDelay);
    }
    
    wasDeepLoadingRef.current = isDeepLoading;
    wasComputingRef.current = isComputingTopology;
  }, [showDeepAnalysisModal, isDeepLoading, isComputingTopology, analysisStep]);
  
  const handleDeepAnalysis = useCallback(() => {
    setShowDeepAnalysisModal(true);
    setAnalysisStep('fetching');
    wasDeepLoadingRef.current = true;
    wasComputingRef.current = false;
    triggerDeepAnalysis();
  }, [triggerDeepAnalysis]);
  
  const handleCloseDeepAnalysis = useCallback(() => {
    setShowDeepAnalysisModal(false);
    setAnalysisStep('fetching');
    wasDeepLoadingRef.current = false;
    wasComputingRef.current = false;
    buildingStartTimeRef.current = 0;
  }, []);
  
  // Compute hub-connected nodes (for Solo Hubs filter)
  const hubConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    for (const hub of meshTopology.hubNodes) {
      connected.add(hub);
      // Find edges connected to this hub
      for (const edge of meshTopology.validatedEdges) {
        if (edge.fromHash === hub) connected.add(edge.toHash);
        if (edge.toHash === hub) connected.add(edge.fromHash);
      }
    }
    return connected;
  }, [meshTopology.hubNodes, meshTopology.validatedEdges]);
  
  // Compute zero-hop (direct) neighbors
  const directNodeSet = useMemo(() => {
    const direct = new Set<string>();
    for (const edge of meshTopology.validatedEdges) {
      if (edge.hopDistanceFromLocal === 0) {
        direct.add(edge.fromHash);
        direct.add(edge.toHash);
      }
    }
    return direct;
  }, [meshTopology.validatedEdges]);
  
  // Map style (static, created once)
  const [mapStyle] = useState(() => createMapStyle());
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Query terrain elevation for all nodes
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isMapLoaded || !terrainEnabled) return;
    
    const map = mapRef.current?.getMap();
    if (!map) return;
    
    // Collect all positions to query
    const positionsToQuery: Array<{ key: string; lng: number; lat: number }> = [];
    
    for (const [hash, neighbor] of Object.entries(neighbors)) {
      if (neighbor.latitude && neighbor.longitude) {
        positionsToQuery.push({ key: hash, lng: neighbor.longitude, lat: neighbor.latitude });
      }
    }
    
    if (localNode?.latitude && localNode?.longitude) {
      positionsToQuery.push({ key: localHash || 'local', lng: localNode.longitude, lat: localNode.latitude });
    }
    
    // Query elevations after terrain tiles load
    const timeoutId = setTimeout(() => {
      const newCache = new Map<string, number>();
      
      for (const pos of positionsToQuery) {
        try {
          // queryTerrainElevation returns elevation in meters
          const elevation = map.queryTerrainElevation({ lng: pos.lng, lat: pos.lat }) ?? 0;
          // Apply exaggeration multiplier to match terrain visual
          newCache.set(pos.key, elevation * 1.5);
        } catch {
          // Terrain not loaded yet, use 0
          newCache.set(pos.key, 0);
        }
      }
      
      setElevationCache(newCache);
    }, ANIMATION.elevationDelay);
    
    return () => clearTimeout(timeoutId);
  }, [isMapLoaded, terrainEnabled, neighbors, localNode, localHash]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Prepare node data for deck.gl (includes elevation and filter visibility)
  // ─────────────────────────────────────────────────────────────────────────────
  const nodeData = useMemo((): NodeData[] => {
    const allNodes: NodeData[] = [];
    
    // Add neighbor nodes
    for (const [hash, neighbor] of Object.entries(neighbors)) {
      if (!neighbor.latitude || !neighbor.longitude) continue;
      
      const isHub = meshTopology.hubNodes.includes(hash);
      const isMobile = meshTopology.mobileNodes.includes(hash);
      const isRoomServer = neighbor.contact_type?.toLowerCase() === 'room server' 
        || neighbor.contact_type?.toLowerCase() === 'room_server';
      
      // Get elevation from cache (0 if not available or terrain disabled)
      const elevation = terrainEnabled ? (elevationCache.get(hash) ?? 0) : 0;
      
      allNodes.push({
        hash,
        position: [neighbor.longitude, neighbor.latitude, elevation],
        name: neighbor.node_name || neighbor.name || 'Unknown',
        isHub,
        isMobile,
        isRoomServer,
        isLocal: false,
        color: getNodeColor(false, isHub, isMobile, isRoomServer),
        radius: isHub ? 600 : 400,
      });
    }
    
    // Add local node
    if (localNode && localNode.latitude && localNode.longitude) {
      const localKey = localHash || 'local';
      const elevation = terrainEnabled ? (elevationCache.get(localKey) ?? 0) : 0;
      
      allNodes.push({
        hash: localKey,
        position: [localNode.longitude, localNode.latitude, elevation],
        name: localNode.name,
        isHub: false,
        isMobile: false,
        isRoomServer: false,
        isLocal: true,
        color: getNodeColor(true, false, false, false),
        radius: 500,
      });
    }
    
    // Apply filters
    if (!soloHubs && !soloDirect) return allNodes;
    
    return allNodes.filter(node => {
      if (node.isLocal) return true; // Always show local node
      if (soloHubs && soloDirect) {
        return hubConnectedNodes.has(node.hash) || directNodeSet.has(node.hash);
      }
      if (soloHubs) return hubConnectedNodes.has(node.hash);
      if (soloDirect) return directNodeSet.has(node.hash);
      return true;
    });
  }, [neighbors, localNode, localHash, meshTopology.hubNodes, meshTopology.mobileNodes, terrainEnabled, elevationCache, soloHubs, soloDirect, hubConnectedNodes, directNodeSet]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Prepare edge data for deck.gl
  // ─────────────────────────────────────────────────────────────────────────────
  const edgeData = useMemo((): EdgeData[] => {
    if (!showTopology) return [];
    
    const edges: EdgeData[] = [];
    const backboneSet = new Set(meshTopology.backboneEdges);
    
    for (const edge of meshTopology.validatedEdges) {
      // Find node positions
      const fromNode = nodeData.find(n => n.hash === edge.fromHash);
      const toNode = nodeData.find(n => n.hash === edge.toHash);
      
      if (!fromNode || !toNode) continue;
      
      const isBackbone = backboneSet.has(`${edge.fromHash}-${edge.toHash}`) 
        || backboneSet.has(`${edge.toHash}-${edge.fromHash}`);
      const isHighlighted = highlightedEdgeKey === `${edge.fromHash}-${edge.toHash}`
        || highlightedEdgeKey === `${edge.toHash}-${edge.fromHash}`;
      
      const color = getEdgeColor(edge.avgConfidence, isBackbone, edge.isDirectPathEdge ?? false);
      const width = getEdgeWidth(edge.certainCount, meshTopology.maxCertainCount);
      
      // Check if this edge is hovered
      const edgeKey = `${edge.fromHash}-${edge.toHash}`;
      const isHovered = hoveredEdgeKey === edgeKey || hoveredEdgeKey === `${edge.toHash}-${edge.fromHash}`;
      const isAnyHovered = hoveredEdgeKey !== null;
      
      // Apply hover effects: brighten hovered, dim others
      const hoverOpacityMult = isAnyHovered ? (isHovered ? 1.25 : 0.4) : 1;
      const hoverWidthMult = isHovered ? 1.3 : 1;
      
      // Blend color with opacity multiplier
      const finalColor: [number, number, number, number] = isHighlighted 
        ? [255, 215, 0, 255]  // Gold for highlighted from PathHealth
        : [
            color[0],
            color[1],
            color[2],
            Math.round(color[3] * hoverOpacityMult),
          ];
      
      edges.push({
        key: edgeKey,
        sourcePosition: fromNode.position,
        targetPosition: toNode.position,
        sourceColor: finalColor,
        targetColor: finalColor,
        width: isHighlighted ? width * 1.5 : width * hoverWidthMult,
        edge,
      });
    }
    
    return edges;
  }, [showTopology, meshTopology.validatedEdges, meshTopology.backboneEdges, meshTopology.maxCertainCount, nodeData, highlightedEdgeKey, hoveredEdgeKey]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Edge fade animation effect
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const wasShowing = prevShowTopologyRef.current;
    prevShowTopologyRef.current = showTopology;
    
    // Toggling ON: animate from 0 to full opacity
    if (!wasShowing && showTopology) {
      setEdgeOpacity(0);
      
      let startTime: number | null = null;
      
      const animate = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / ANIMATION.edgeFadeIn, 1);
        // Ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        setEdgeOpacity(eased);
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };
      
      requestAnimationFrame(animate);
    }
    
    // Toggling OFF: quick fade to 0
    if (wasShowing && !showTopology) {
      let startTime: number | null = null;
      const startOpacity = edgeOpacity;
      
      const animate = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / ANIMATION.edgeFadeOut, 1);
        // Ease-out
        const eased = 1 - Math.pow(1 - progress, 2);
        setEdgeOpacity(startOpacity * (1 - eased));
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };
      
      requestAnimationFrame(animate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTopology]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Create deck.gl layers
  // ─────────────────────────────────────────────────────────────────────────────
  const layers = useMemo(() => [
    // Topology edges (arcs in 3D)
    new ArcLayer<EdgeData>({
      id: 'topology-edges',
      data: edgeData,
      getSourcePosition: d => d.sourcePosition,
      getTargetPosition: d => d.targetPosition,
      getSourceColor: d => d.sourceColor,
      getTargetColor: d => d.targetColor,
      getWidth: d => d.width,
      getHeight: 0.3, // Arc height multiplier
      greatCircle: false, // Straight lines for local networks
      widthUnits: 'pixels',
      widthMinPixels: 1,
      widthMaxPixels: 12,
      pickable: true,
      visible: showTopology || edgeOpacity > 0, // Keep visible during fade-out
      opacity: edgeOpacity,
      // Smooth transitions when data updates
      transitions: {
        getSourceColor: ANIMATION.colorTransition,
        getTargetColor: ANIMATION.colorTransition,
        getWidth: ANIMATION.colorTransition,
      },
      // Edge hover handling
      onHover: (info: PickingInfo<EdgeData>) => {
        setHoveredEdgeKey(info.object?.key ?? null);
      },
      // Update triggers for hover state
      updateTriggers: {
        getSourceColor: [hoveredEdgeKey, highlightedEdgeKey],
        getTargetColor: [hoveredEdgeKey, highlightedEdgeKey],
        getWidth: [hoveredEdgeKey, highlightedEdgeKey],
      },
    }),
    
    // Node markers
    new ScatterplotLayer<NodeData>({
      id: 'nodes',
      data: nodeData,
      getPosition: d => d.position,
      getFillColor: d => d.color,
      getRadius: d => d.radius,
      radiusUnits: 'meters',
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 80],
      lineWidthMinPixels: 1,
      onHover: (info: PickingInfo<NodeData>) => {
        setHoveredNode(info.object ?? null);
      },
      onClick: (info: PickingInfo<NodeData>) => {
        if (info.object) {
          setSelectedNode(info.object);
        }
      },
    }),
  ], [nodeData, edgeData, showTopology, edgeOpacity, hoveredEdgeKey, highlightedEdgeKey]);
  
  // Handle map load
  const handleMapLoad = useCallback((_event: MapLibreEvent) => {
    setIsMapLoaded(true);
  }, []);
  
  // Toggle terrain mode (3D perspective with elevation vs flat)
  const toggleTerrain = useCallback(() => {
    setTerrainEnabled(prev => {
      const newEnabled = !prev;
      
      // Update pitch based on mode
      setViewState(v => ({
        ...v,
        pitch: newEnabled ? 45 : 0,
      }));
      
      // Toggle terrain on MapLibre instance
      const map = mapRef.current?.getMap();
      if (map) {
        if (newEnabled) {
          map.setTerrain({ source: 'terrain', exaggeration: 1.5 });
        } else {
          map.setTerrain(null);
        }
      }
      
      return newEnabled;
    });
  }, []);
  
  // Center on local node when it changes
  useEffect(() => {
    if (localNode && isMapLoaded) {
      setViewState(v => ({
        ...v,
        longitude: localNode.longitude,
        latitude: localNode.latitude,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- localNode changes tracked via longitude/latitude
  }, [localNode?.longitude, localNode?.latitude, isMapLoaded]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Fullscreen Support
  // ─────────────────────────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (!mapContainerRef.current) return;
    
    const elem = mapContainerRef.current as FullscreenElement;
    const doc = document as FullscreenDocument;
    
    const nativeFullscreenSupported = !!(elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen);
    
    if (!isFullscreen) {
      if (nativeFullscreenSupported) {
        if (elem.requestFullscreen) {
          elem.requestFullscreen().catch(() => setIsFullscreen(true));
        } else if (elem.webkitRequestFullscreen) {
          elem.webkitRequestFullscreen();
        } else if (elem.msRequestFullscreen) {
          elem.msRequestFullscreen();
        }
      } else {
        setIsFullscreen(true);
      }
    } else {
      const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
      if (fullscreenElement) {
        if (doc.exitFullscreen) {
          doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          doc.webkitExitFullscreen();
        } else if (doc.msExitFullscreen) {
          doc.msExitFullscreen();
        }
      } else {
        setIsFullscreen(false);
      }
    }
  }, [isFullscreen]);
  
  // Listen for native fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const doc = document as FullscreenDocument;
      setIsFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement));
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);
  
  // Handle escape key for CSS-based fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const doc = document as FullscreenDocument;
        const isNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
        if (!isNativeFullscreen) setIsFullscreen(false);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);
  
  // Lock body scroll in CSS-based fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    
    const doc = document as FullscreenDocument;
    const isNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
    
    if (!isNativeFullscreen) {
      const scrollY = window.scrollY;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
      
      return () => {
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        window.scrollTo(0, scrollY);
      };
    }
  }, [isFullscreen]);
  
  // Check for room servers in data
  const hasRoomServers = useMemo(() => {
    return Object.values(neighbors).some(n => 
      n.contact_type?.toLowerCase() === 'room server' ||
      n.contact_type?.toLowerCase() === 'room_server'
    );
  }, [neighbors]);
  
  // Fullscreen styles
  const fullscreenStyles: React.CSSProperties = isFullscreen ? {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100vw',
    height: '100dvh',
    zIndex: 9999,
    borderRadius: 0,
  } : {
    height: '500px',
  };
  
  return (
    <div 
      ref={mapContainerRef}
      className={`relative w-full ${isFullscreen ? '' : 'rounded-[1.125rem]'}`}
      style={fullscreenStyles}
    >
      <MapLibreMap
        ref={mapRef}
        {...viewState}
        onMove={evt => setViewState({
          longitude: evt.viewState.longitude,
          latitude: evt.viewState.latitude,
          zoom: evt.viewState.zoom,
          pitch: evt.viewState.pitch,
          bearing: evt.viewState.bearing,
        })}
        onLoad={handleMapLoad}
        mapStyle={mapStyle}
        maxPitch={85} // MapLibre v2+ supports up to 85°
        attributionControl={false} // We'll add custom attribution
        style={{ width: '100%', height: '100%' }}
        cursor={hoveredNode ? 'pointer' : 'grab'}
      >
        {/* deck.gl overlay for 3D visualization */}
        <DeckGLOverlay layers={layers} interleaved />
      </MapLibreMap>
      
      {/* Controls overlay */}
      <div className="absolute top-4 right-4 z-[600] flex gap-2">
        {/* Terrain toggle (3D perspective vs flat) */}
        <button
          onClick={toggleTerrain}
          className="p-2 transition-colors hover:bg-white/10"
          style={{
            background: 'rgba(20, 20, 22, 0.95)',
            borderRadius: '0.75rem',
            border: `1px solid ${terrainEnabled ? 'rgba(67, 56, 202, 0.6)' : 'rgba(140, 160, 200, 0.2)'}`,
          }}
          title={terrainEnabled ? 'Disable terrain (flat view)' : 'Enable terrain (3D elevation)'}
        >
          {terrainEnabled ? (
            <Box className="w-4 h-4 text-indigo-400" />
          ) : (
            <MapIcon className="w-4 h-4 text-text-secondary" />
          )}
        </button>
        
        {/* Topology toggle */}
        <button
          onClick={() => setShowTopology(!showTopology)}
          className="p-2 transition-colors hover:bg-white/10"
          style={{
            background: showTopology ? 'rgba(67, 56, 202, 0.25)' : 'rgba(20, 20, 22, 0.95)',
            borderRadius: '0.75rem',
            border: `1px solid ${showTopology ? 'rgba(67, 56, 202, 0.5)' : 'rgba(140, 160, 200, 0.2)'}`,
          }}
          title={showTopology ? 'Hide topology edges' : 'Show topology edges'}
        >
          <GitBranch className={`w-4 h-4 ${showTopology ? 'text-indigo-400' : 'text-text-secondary'}`} />
        </button>
        
        {/* Solo Hubs toggle */}
        {meshTopology.hubNodes.length > 0 && (
          <button
            onClick={() => setSoloHubs(!soloHubs)}
            className="p-2 transition-colors hover:bg-white/10"
            style={{
              background: soloHubs ? 'rgba(251, 191, 36, 0.25)' : 'rgba(20, 20, 22, 0.95)',
              borderRadius: '0.75rem',
              border: `1px solid ${soloHubs ? 'rgba(251, 191, 36, 0.5)' : 'rgba(140, 160, 200, 0.2)'}`,
            }}
            title={soloHubs ? 'Show all nodes' : 'Solo hub connections'}
          >
            <Network className={`w-4 h-4 ${soloHubs ? 'text-amber-400' : 'text-text-secondary'}`} />
          </button>
        )}
        
        {/* Solo Direct toggle */}
        {directNodeSet.size > 0 && (
          <button
            onClick={() => setSoloDirect(!soloDirect)}
            className="p-2 transition-colors hover:bg-white/10"
            style={{
              background: soloDirect ? 'rgba(67, 56, 202, 0.35)' : 'rgba(20, 20, 22, 0.95)',
              borderRadius: '0.75rem',
              border: `1px solid ${soloDirect ? 'rgba(67, 56, 202, 0.6)' : 'rgba(140, 160, 200, 0.2)'}`,
            }}
            title={soloDirect ? 'Show all nodes' : 'Solo direct (0-hop) nodes'}
          >
            <Radio className={`w-4 h-4 ${soloDirect ? 'text-indigo-400' : 'text-text-secondary'}`} />
          </button>
        )}
        
        {/* Fullscreen button */}
        <button
          onClick={toggleFullscreen}
          className="p-2 transition-colors hover:bg-white/10"
          style={{
            background: 'rgba(20, 20, 22, 0.95)',
            borderRadius: '0.75rem',
            border: '1px solid rgba(140, 160, 200, 0.2)',
          }}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <Minimize2 className="w-4 h-4 text-text-secondary" />
          ) : (
            <Maximize2 className="w-4 h-4 text-text-secondary" />
          )}
        </button>
      </div>
      
      {/* Deep Analysis button - top left */}
      <div className="absolute top-4 left-4 z-[600]">
        <button
          onClick={handleDeepAnalysis}
          disabled={packetCacheState.isDeepLoading || showDeepAnalysisModal}
          className="px-3 py-2 flex items-center gap-2 transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'rgba(20, 20, 22, 0.95)',
            borderRadius: '0.75rem',
            border: '1px solid rgba(140, 160, 200, 0.2)',
          }}
          title="Deep Analysis - Load full packet history and rebuild topology"
        >
          <span className="text-xs font-medium text-text-primary">Deep Analysis</span>
          <BarChart2 className="w-4 h-4 text-accent-primary" />
        </button>
      </div>
      
      {/* Legend - bottom left */}
      <div 
        className="absolute bottom-4 left-4 z-[600] text-xs"
        style={{
          background: 'rgba(20, 20, 22, 0.95)',
          borderRadius: '0.75rem',
          padding: '0.625rem',
          border: '1px solid rgba(140, 160, 200, 0.2)',
          maxWidth: '150px',
        }}
      >
        {/* Node types legend */}
        <div className="text-text-secondary font-medium mb-1.5 flex items-center gap-1">
          Nodes
          <span className="group relative cursor-help">
            <Info className="w-3 h-3 text-text-muted" />
            <div 
              className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight rounded-lg z-10"
              style={{
                background: 'rgba(20, 20, 22, 0.98)',
                border: '1px solid rgba(140, 160, 200, 0.3)',
              }}
            >
              All nodes shown in network accent color. Hubs are filled; others are rings.
            </div>
          </span>
        </div>
        <div className="flex flex-col gap-1">
          {/* Standard node ring */}
          <div className="flex items-center gap-1.5">
            <div 
              className="w-3 h-3 rounded-full flex-shrink-0" 
              style={{ 
                background: 'transparent',
                border: `3px solid ${DESIGN.nodeColor}`,
                boxSizing: 'border-box',
              }}
            />
            <span className="text-text-muted">Node</span>
          </div>
          {/* Hub filled */}
          <div className="flex items-center gap-1.5">
            <div 
              className="w-3 h-3 rounded-full flex-shrink-0" 
              style={{ backgroundColor: DESIGN.hubColor }}
            />
            <span className="text-text-muted">Hub</span>
          </div>
          {/* Local node */}
          <div className="flex items-center gap-1.5">
            <Home 
              className="w-3 h-3 flex-shrink-0" 
              style={{ color: DESIGN.localColor }}
              strokeWidth={2.5}
            />
            <span className="text-text-muted">Local</span>
          </div>
          {/* Room server */}
          {hasRoomServers && (
            <div className="flex items-center gap-1.5">
              <MessageCircle 
                className="w-3 h-3 flex-shrink-0" 
                style={{ color: DESIGN.roomServerColor }}
                strokeWidth={2.5}
              />
              <span className="text-text-muted">Room</span>
            </div>
          )}
          {/* Mobile node */}
          {meshTopology.mobileNodes.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div 
                className="w-3 h-3 rounded-full flex-shrink-0" 
                style={{ 
                  background: 'transparent',
                  border: `3px solid ${DESIGN.mobileColor}`,
                  boxSizing: 'border-box',
                }}
              />
              <span className="text-text-muted">Mobile</span>
            </div>
          )}
        </div>
        
        {/* Topology stats */}
        {showTopology && edgeData.length > 0 && (
          <>
            <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1 flex items-center gap-1">
              Topology
              <span className="group relative cursor-help">
                <Info className="w-3 h-3 text-text-muted" />
                <div 
                  className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight rounded-lg z-10"
                  style={{
                    background: 'rgba(20, 20, 22, 0.98)',
                    border: '1px solid rgba(140, 160, 200, 0.3)',
                  }}
                >
                  Links with 5+ validations. Thickness = relative strength.
                </div>
              </span>
            </div>
            <div className="flex flex-col gap-0.5 text-text-muted">
              <div className="flex justify-between tabular-nums">
                <span>Nodes</span>
                <span className="text-text-secondary">{nodeData.length}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>Links</span>
                <span className="text-text-secondary">{edgeData.length}</span>
              </div>
              {meshTopology.hubNodes.length > 0 && (
                <div className="flex justify-between tabular-nums">
                  <span>Hubs</span>
                  <span style={{ color: DESIGN.hubColor }}>{meshTopology.hubNodes.length}</span>
                </div>
              )}
            </div>
            
            {/* Link types */}
            <div className="flex flex-col gap-1 mt-1.5 pt-1.5 border-t border-white/10">
              <div className="flex items-center gap-1.5">
                <div 
                  className="flex-shrink-0" 
                  style={{ 
                    width: '14px',
                    height: '3px',
                    backgroundColor: DESIGN.edges.standard,
                    borderRadius: '1px',
                  }}
                />
                <span className="text-text-muted">Link</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div 
                  className="flex-shrink-0" 
                  style={{ 
                    width: '14px',
                    height: '3px',
                    backgroundColor: DESIGN.edges.direct,
                    borderRadius: '1px',
                  }}
                />
                <span className="text-text-muted">Direct</span>
              </div>
              {meshTopology.loops.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="flex-shrink-0 flex flex-col gap-0.5" style={{ width: '14px' }}>
                    <div style={{ height: '2px', backgroundColor: DESIGN.edges.loop, borderRadius: '1px' }} />
                    <div style={{ height: '2px', backgroundColor: DESIGN.edges.loop, borderRadius: '1px' }} />
                  </div>
                  <span className="text-text-muted">Redundant</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      
      {/* Click popup - MapLibre native popup */}
      {selectedNode && (
        <Popup
          longitude={selectedNode.position[0]}
          latitude={selectedNode.position[1]}
          anchor="bottom"
          onClose={() => setSelectedNode(null)}
          closeOnClick={false}
          className="maplibre-popup-dark"
          maxWidth="280px"
        >
          <div className="p-2">
            <div className="text-text-primary font-semibold text-base">{selectedNode.name}</div>
            <div className="text-text-muted text-xs font-mono mt-1">
              {selectedNode.hash}
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {selectedNode.isHub && (
                <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 text-xs rounded">Hub</span>
              )}
              {selectedNode.isMobile && (
                <span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 text-xs rounded">Mobile</span>
              )}
              {selectedNode.isRoomServer && (
                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-xs rounded">Room Server</span>
              )}
              {selectedNode.isLocal && (
                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-xs rounded">Local</span>
              )}
              {directNodeSet.has(selectedNode.hash) && !selectedNode.isLocal && (
                <span className="px-2 py-0.5 bg-teal-500/20 text-teal-400 text-xs rounded">Direct</span>
              )}
            </div>
          </div>
        </Popup>
      )}
      
      {/* Hover tooltip (bottom bar) */}
      {hoveredNode && !selectedNode && (
        <div 
          className="absolute z-[700] pointer-events-none px-3 py-2 rounded-lg"
          style={{
            background: 'rgba(20, 20, 22, 0.95)',
            border: '1px solid rgba(140, 160, 200, 0.2)',
            left: '50%',
            bottom: '1rem',
            transform: 'translateX(-50%)',
          }}
        >
          <div className="text-text-primary font-medium">{hoveredNode.name}</div>
          <div className="text-text-muted text-xs font-mono">
            {hoveredNode.hash.slice(0, 8)}...
          </div>
          {hoveredNode.isHub && <div className="text-indigo-400 text-xs">Hub node</div>}
          {hoveredNode.isMobile && <div className="text-orange-400 text-xs">Mobile</div>}
          {hoveredNode.isRoomServer && <div className="text-amber-400 text-xs">Room Server</div>}
          {hoveredNode.isLocal && <div className="text-amber-400 text-xs">Local Node</div>}
        </div>
      )}
      
      {/* Deep Analysis Modal */}
      <DeepAnalysisModal
        isOpen={showDeepAnalysisModal}
        currentStep={analysisStep}
        packetCount={packetCacheState.packetCount}
        onClose={handleCloseDeepAnalysis}
      />
      
      {/* Status indicator */}
      {!isMapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-body/80 z-[500]">
          <div className="text-text-secondary">Loading map...</div>
        </div>
      )}
    </div>
  );
}
