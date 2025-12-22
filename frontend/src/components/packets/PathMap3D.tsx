/**
 * PathMap3D - MapLibre GL + deck.gl path visualization
 * Shows packet routing path with 3D terrain and arc visualization
 */

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Deck } from '@deck.gl/core';
import { ScatterplotLayer, ArcLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ResolvedPath, PathCandidate, LocalNode } from './PathMapVisualization';

// Animation timing constants
const ANIMATION = {
  arcFadeIn: 600,
  arcDelay: 100, // stagger per hop
  markerFadeIn: 400,
};

// Colors matching theme
const COLORS = {
  // Node markers
  localNode: [251, 191, 36] as [number, number, number],      // Amber-400 (house icon)
  hubNode: [99, 102, 241] as [number, number, number],        // Indigo-500
  standardNode: [67, 56, 202] as [number, number, number],    // Indigo-700
  sourceNode: [57, 217, 138] as [number, number, number],     // accent-success
  
  // Path arcs - gradient from green (source) to indigo (destination)
  arcSource: [57, 217, 138] as [number, number, number],      // accent-success
  arcTarget: [139, 92, 246] as [number, number, number],      // purple-500
  
  // Hover highlight
  hoverHighlight: [180, 157, 255] as [number, number, number], // accent-primary
};

interface PathMap3DProps {
  resolvedPath: ResolvedPath;
  localNode?: LocalNode;
  hubNodes?: string[];
  hoveredHopIndex: number | null;
  onHoverHop: (index: number | null) => void;
}

// Get elevation for a coordinate (approximate based on terrain)
async function getElevation(
  map: maplibregl.Map | null,
  lng: number,
  lat: number
): Promise<number> {
  if (!map) return 0;
  
  try {
    const terrain = map.getTerrain();
    if (terrain) {
      const elevation = map.queryTerrainElevation([lng, lat]);
      return elevation || 0;
    }
  } catch {
    // Terrain not available
  }
  return 0;
}

export default function PathMap3D({
  resolvedPath,
  localNode: _localNode,
  hubNodes = [],
  hoveredHopIndex,
  onHoverHop,
}: PathMap3DProps) {
  // Convert hubNodes array to Set for efficient lookups
  const hubSet = useMemo(() => new Set(hubNodes), [hubNodes]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<Deck | null>(null);
  
  // Animation state
  const [animationProgress, setAnimationProgress] = useState(0);
  const [nodeElevations, setNodeElevations] = useState<Map<string, number>>(new Map());
  
  // Tooltip state for hovered node
  const [tooltipInfo, setTooltipInfo] = useState<{ x: number; y: number; node: typeof pathNodes[0] } | null>(null);
  
  // Extract valid candidates with coordinates
  const pathNodes = useMemo(() => {
    const nodes: Array<{
      hop: PathCandidate;
      hopIndex: number;
      isSource: boolean;
      isLocal: boolean;
      isHub: boolean;
    }> = [];
    
    resolvedPath.hops.forEach((hop, i) => {
      const bestCandidate = hop.candidates[0];
      if (bestCandidate?.latitude && bestCandidate?.longitude) {
        const isSource = 'isSource' in hop && hop.isSource === true;
        nodes.push({
          hop: bestCandidate,
          hopIndex: i,
          isSource,
          isLocal: bestCandidate.isLocal || false,
          isHub: hubSet.has(bestCandidate.hash),
        });
      }
    });
    
    return nodes;
  }, [resolvedPath, hubSet]);
  
  // Build arc data for path connections
  const arcData = useMemo(() => {
    const arcs: Array<{
      source: [number, number, number];
      target: [number, number, number];
      sourceIndex: number;
      targetIndex: number;
      progress: number;
    }> = [];
    
    for (let i = 0; i < pathNodes.length - 1; i++) {
      const from = pathNodes[i];
      const to = pathNodes[i + 1];
      
      const fromElevation = nodeElevations.get(from.hop.hash) || 0;
      const toElevation = nodeElevations.get(to.hop.hash) || 0;
      
      // Staggered animation progress per hop
      const hopDelay = i * ANIMATION.arcDelay;
      const hopProgress = Math.max(0, Math.min(1, 
        (animationProgress * ANIMATION.arcFadeIn - hopDelay) / ANIMATION.arcFadeIn
      ));
      
      arcs.push({
        source: [from.hop.longitude, from.hop.latitude, fromElevation + 50],
        target: [to.hop.longitude, to.hop.latitude, toElevation + 50],
        sourceIndex: from.hopIndex,
        targetIndex: to.hopIndex,
        progress: hopProgress,
      });
    }
    
    return arcs;
  }, [pathNodes, nodeElevations, animationProgress]);
  
  // Calculate bounds to fit all nodes
  const bounds = useMemo(() => {
    if (pathNodes.length === 0) return null;
    
    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    
    pathNodes.forEach(({ hop }) => {
      minLng = Math.min(minLng, hop.longitude);
      maxLng = Math.max(maxLng, hop.longitude);
      minLat = Math.min(minLat, hop.latitude);
      maxLat = Math.max(maxLat, hop.latitude);
    });
    
    // Add padding
    const lngPad = Math.max(0.01, (maxLng - minLng) * 0.2);
    const latPad = Math.max(0.01, (maxLat - minLat) * 0.2);
    
    return {
      sw: [minLng - lngPad, minLat - latPad] as [number, number],
      ne: [maxLng + lngPad, maxLat + latPad] as [number, number],
    };
  }, [pathNodes]);
  
  // Get node color based on type
  const getNodeColor = useCallback((node: typeof pathNodes[0], isHovered: boolean): [number, number, number, number] => {
    const alpha = isHovered ? 255 : 200;
    
    if (node.isSource) {
      return [...COLORS.sourceNode, alpha];
    }
    if (node.isLocal) {
      return [...COLORS.localNode, alpha];
    }
    if (node.isHub) {
      return [...COLORS.hubNode, alpha];
    }
    return [...COLORS.standardNode, alpha];
  }, []);
  
  // Get node radius based on type and hover
  const getNodeRadius = useCallback((node: typeof pathNodes[0], isHovered: boolean): number => {
    const baseRadius = node.isLocal || node.isHub || node.isSource ? 8 : 6;
    return isHovered ? baseRadius * 1.5 : baseRadius;
  }, []);
  
  // Update deck.gl layers
  const updateLayers = useCallback(() => {
    if (!deckRef.current) return;
    
    const layers = [
      // Path arcs
      new ArcLayer({
        id: 'path-arcs',
        data: arcData,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getSourceColor: (d) => {
          const isHovered = hoveredHopIndex === d.sourceIndex || hoveredHopIndex === d.targetIndex;
          if (isHovered) {
            return [...COLORS.hoverHighlight, 255] as [number, number, number, number];
          }
          return [...COLORS.arcSource, Math.floor(d.progress * 200)] as [number, number, number, number];
        },
        getTargetColor: (d) => {
          const isHovered = hoveredHopIndex === d.sourceIndex || hoveredHopIndex === d.targetIndex;
          if (isHovered) {
            return [...COLORS.hoverHighlight, 255] as [number, number, number, number];
          }
          return [...COLORS.arcTarget, Math.floor(d.progress * 200)] as [number, number, number, number];
        },
        getWidth: (d) => {
          const isHovered = hoveredHopIndex === d.sourceIndex || hoveredHopIndex === d.targetIndex;
          return isHovered ? 4 : 2;
        },
        getHeight: 0.5, // Arc height factor
        greatCircle: false,
        pickable: true,
        updateTriggers: {
          getSourceColor: [hoveredHopIndex, animationProgress],
          getTargetColor: [hoveredHopIndex, animationProgress],
          getWidth: [hoveredHopIndex],
        },
      }),
      
      // Node markers
      new ScatterplotLayer({
        id: 'path-nodes',
        data: pathNodes,
        getPosition: d => {
          const elevation = nodeElevations.get(d.hop.hash) || 0;
          return [d.hop.longitude, d.hop.latitude, elevation + 50];
        },
        getFillColor: d => getNodeColor(d, hoveredHopIndex === d.hopIndex),
        getLineColor: d => {
          const isHovered = hoveredHopIndex === d.hopIndex;
          if (isHovered) {
            return [255, 255, 255, 255] as [number, number, number, number];
          }
          return [0, 0, 0, 100] as [number, number, number, number];
        },
        getRadius: d => getNodeRadius(d, hoveredHopIndex === d.hopIndex),
        radiusUnits: 'pixels',
        stroked: true,
        lineWidthMinPixels: 1,
        pickable: true,
        onHover: (info) => {
          if (info.object) {
            onHoverHop(info.object.hopIndex);
            setTooltipInfo({ x: info.x, y: info.y, node: info.object });
          } else {
            onHoverHop(null);
            setTooltipInfo(null);
          }
        },
        updateTriggers: {
          getFillColor: [hoveredHopIndex],
          getLineColor: [hoveredHopIndex],
          getRadius: [hoveredHopIndex],
        },
      }),
    ];
    
    deckRef.current.setProps({ layers });
  }, [arcData, pathNodes, nodeElevations, hoveredHopIndex, onHoverHop, getNodeColor, getNodeRadius, animationProgress]);
  
  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
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
            attribution: '&copy; OpenStreetMap &copy; CARTO',
          },
          // Terrain DEM - Global Terrarium tiles on AWS (free, no key required)
          'terrain-source': {
            type: 'raster-dem',
            tiles: [
              'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
              'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
            ],
            tileSize: 256,
            maxzoom: 15,
            encoding: 'terrarium',
          },
        },
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': '#08090B' },
          },
          {
            id: 'carto-layer',
            type: 'raster',
            source: 'carto',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
        terrain: {
          source: 'terrain-source',
          exaggeration: 1.5,
        },
      },
      center: bounds ? [(bounds.sw[0] + bounds.ne[0]) / 2, (bounds.sw[1] + bounds.ne[1]) / 2] : [-117.5, 33.5],
      zoom: 10,
      pitch: 45,
      bearing: 0,
      attributionControl: false,
    });
    
    mapRef.current = map;
    
    map.on('load', () => {
      // Fit bounds if we have nodes
      if (bounds) {
        map.fitBounds([bounds.sw, bounds.ne], {
          padding: 40,
          pitch: 45,
          bearing: -20,
          duration: 0,
        });
      }
      
      // Initialize deck.gl
      const deck = new Deck({
        parent: containerRef.current!,
        style: { position: 'absolute', top: '0', left: '0' },
        initialViewState: {
          longitude: map.getCenter().lng,
          latitude: map.getCenter().lat,
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        },
        controller: false,
        layers: [],
      });
      
      deckRef.current = deck;
      
      // Sync deck.gl with map movement
      const syncDeck = () => {
        if (!deckRef.current) return;
        deckRef.current.setProps({
          initialViewState: {
            longitude: map.getCenter().lng,
            latitude: map.getCenter().lat,
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
          },
        });
      };
      
      map.on('move', syncDeck);
      map.on('moveend', syncDeck);
      
      // Fetch elevations for nodes
      const fetchElevations = async () => {
        const elevations = new Map<string, number>();
        for (const node of pathNodes) {
          const elevation = await getElevation(map, node.hop.longitude, node.hop.latitude);
          elevations.set(node.hop.hash, elevation);
        }
        setNodeElevations(elevations);
      };
      
      fetchElevations();
      
      // Start animation
      const startTime = Date.now();
      const animateIn = () => {
        const elapsed = Date.now() - startTime;
        const totalDuration = ANIMATION.arcFadeIn + (pathNodes.length - 1) * ANIMATION.arcDelay;
        const progress = Math.min(1, elapsed / totalDuration);
        setAnimationProgress(progress);
        
        if (progress < 1) {
          requestAnimationFrame(animateIn);
        }
      };
      animateIn();
    });
    
    return () => {
      deckRef.current?.finalize();
      deckRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []); // Only run on mount
  
  // Update layers when data changes
  useEffect(() => {
    updateLayers();
  }, [updateLayers]);
  
  // Update bounds when path changes
  useEffect(() => {
    if (mapRef.current && bounds) {
      mapRef.current.fitBounds([bounds.sw, bounds.ne], {
        padding: 40,
        pitch: 45,
        bearing: -20,
        duration: 500,
      });
    }
  }, [bounds]);
  
  // Get hash prefix for display
  const getHashPrefix = (hash: string): string => {
    const clean = hash.startsWith('0x') ? hash.slice(2) : hash;
    return clean.slice(0, 2).toUpperCase();
  };

  return (
    <div 
      ref={containerRef} 
      className="relative h-[200px] w-full"
      style={{ cursor: tooltipInfo ? 'pointer' : 'grab' }}
    >
      {/* Tooltip overlay */}
      {tooltipInfo && (
        <div
          className="absolute pointer-events-none z-50"
          style={{
            left: tooltipInfo.x + 10,
            top: tooltipInfo.y - 30,
            transform: 'translateY(-100%)',
          }}
        >
          <div
            className="px-2 py-1.5 rounded-lg text-xs shadow-lg"
            style={{
              background: 'rgba(20, 20, 22, 0.95)',
              border: '1px solid rgba(140, 160, 200, 0.25)',
              maxWidth: '180px',
            }}
          >
            <div className="font-semibold text-text-primary truncate">
              {tooltipInfo.node.hop.name}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <code className="font-mono text-[10px] text-text-muted/70 bg-white/5 px-1 py-px rounded">
                {getHashPrefix(tooltipInfo.node.hop.hash)}
              </code>
              {tooltipInfo.node.isSource && (
                <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-green-500/25 text-green-400">Source</span>
              )}
              {tooltipInfo.node.isLocal && (
                <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-amber-500/25 text-amber-400">Local</span>
              )}
              {tooltipInfo.node.isHub && (
                <span className="px-1 py-px text-[8px] font-bold uppercase rounded" style={{ backgroundColor: '#FBBF24', color: '#000' }}>Hub</span>
              )}
            </div>
            <div className="text-[10px] text-text-muted/60 mt-0.5">
              Hop {tooltipInfo.node.hopIndex + 1} of {pathNodes.length}
              {tooltipInfo.node.hop.probability < 1 && (
                <span className="ml-1">({Math.round(tooltipInfo.node.hop.probability * 100)}% conf)</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
