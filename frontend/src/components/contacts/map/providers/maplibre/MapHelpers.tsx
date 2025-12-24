/**
 * MapLibre Map Helper Components
 * 
 * Small utility components that use MapLibre's map instance for specific behaviors.
 * Direct port from Leaflet version - maintains exact behavior parity.
 * 
 * @module providers/maplibre/MapHelpers
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-map-gl/maplibre';
import type { LngLatBoundsLike } from 'maplibre-gl';
import type { TopologyEdge } from '@/lib/mesh-topology';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface EdgePolylineData {
  from: [number, number];
  to: [number, number];
  edge: TopologyEdge;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FitBoundsOnce
// ═══════════════════════════════════════════════════════════════════════════════

interface FitBoundsOnceProps {
  /** Positions as [lat, lng] pairs (Leaflet order) */
  positions: [number, number][];
}

/**
 * Fit map bounds only on initial load (not when user navigates).
 * Automatically adjusts zoom and center to show all positions.
 */
export function FitBoundsOnce({ positions }: FitBoundsOnceProps) {
  const { current: map } = useMap();
  const hasFitted = useRef(false);
  
  useEffect(() => {
    if (!map || positions.length === 0 || hasFitted.current) return;
    
    hasFitted.current = true;
    
    if (positions.length === 1) {
      // Single position: center and zoom
      // Convert from [lat, lng] to [lng, lat] for MapLibre
      map.flyTo({
        center: [positions[0][1], positions[0][0]],
        zoom: 14,
        duration: 1000,
      });
    } else {
      // Multiple positions: fit bounds
      // Convert from [lat, lng] to [lng, lat] for MapLibre
      const lngLatPositions = positions.map(([lat, lng]) => [lng, lat] as [number, number]);
      
      // Calculate bounds
      let minLng = Infinity, maxLng = -Infinity;
      let minLat = Infinity, maxLat = -Infinity;
      
      for (const [lng, lat] of lngLatPositions) {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
      
      const bounds: LngLatBoundsLike = [
        [minLng, minLat], // southwest
        [maxLng, maxLat], // northeast
      ];
      
      // Minimal padding for tighter framing of the mesh
      map.fitBounds(bounds, {
        padding: { top: 15, bottom: 15, left: 15, right: 15 },
        maxZoom: 16,
        duration: 1000,
      });
    }
  }, [map, positions]);
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZoomToNode
// ═══════════════════════════════════════════════════════════════════════════════

interface ZoomToNodeProps {
  targetHash: string | null;
  /** Node coordinates as Map<hash, [lat, lng]> (Leaflet order) */
  nodeCoordinates: Map<string, [number, number]>;
  onComplete?: () => void;
}

/**
 * Zoom to a specific node when targetHash is set.
 * Uses flyTo for smooth animation with easing.
 */
export function ZoomToNode({ targetHash, nodeCoordinates, onComplete }: ZoomToNodeProps) {
  const { current: map } = useMap();
  const processedRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (!map || !targetHash || targetHash === processedRef.current) return;
    
    const coords = nodeCoordinates.get(targetHash);
    if (!coords) return;
    
    processedRef.current = targetHash;
    
    // Convert from [lat, lng] to [lng, lat] for MapLibre
    const [lat, lng] = coords;
    
    // Zoom to node with smooth animation
    // MapLibre's flyTo has built-in easing
    map.flyTo({
      center: [lng, lat],
      zoom: 15,
      duration: 2500,
      essential: true,
    });
    
    // After zoom completes, trigger callback
    // MapLibre flyTo doesn't have a direct callback, so use timeout matching duration
    setTimeout(() => {
      onComplete?.();
    }, 2600);
  }, [targetHash, nodeCoordinates, map, onComplete]);
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EdgeHighlighter
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeHighlighterProps {
  highlightedEdgeKey: string | null | undefined;
  validatedPolylines: EdgePolylineData[];
  weakPolylines: EdgePolylineData[];
  onEnsureTopology: () => void;
}

/**
 * Highlight helper: when an edge is selected, ensure topology is visible and pan/zoom to it.
 * Used by PathHealth panel to show weakest links on the map.
 */
export function EdgeHighlighter({
  highlightedEdgeKey,
  validatedPolylines,
  weakPolylines,
  onEnsureTopology,
}: EdgeHighlighterProps) {
  const { current: map } = useMap();
  
  useEffect(() => {
    if (!map || !highlightedEdgeKey) return;
    
    // Ensure topology is visible
    onEnsureTopology();
    
    // Find the edge in either set
    const line = validatedPolylines.find(l => l.edge.key === highlightedEdgeKey) 
      || weakPolylines.find(l => l.edge.key === highlightedEdgeKey);
    
    if (!line) return;
    
    // Calculate midpoint (in [lat, lng] format from the data)
    const midLat = (line.from[0] + line.to[0]) / 2;
    const midLng = (line.from[1] + line.to[1]) / 2;
    
    // Get current zoom and use at least 11
    const currentZoom = map.getZoom();
    const targetZoom = Math.max(currentZoom, 11);
    
    // Smooth pan to edge midpoint
    // Convert to [lng, lat] for MapLibre
    map.flyTo({
      center: [midLng, midLat],
      zoom: targetZoom,
      duration: 500,
      essential: true,
    });
  }, [highlightedEdgeKey, validatedPolylines, weakPolylines, map, onEnsureTopology]);
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// useMapInstance Hook
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hook to get the MapLibre map instance.
 * Useful for imperative operations not covered by declarative components.
 */
export function useMapInstance() {
  const { current: map } = useMap();
  return map;
}
