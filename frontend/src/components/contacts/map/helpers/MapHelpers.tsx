/**
 * Map Helper Components
 * 
 * Small utility components that use Leaflet's useMap hook for specific behaviors.
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
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
  positions: [number, number][];
}

/**
 * Fit map bounds only on initial load (not when user navigates).
 * Automatically adjusts zoom and center to show all positions.
 */
export function FitBoundsOnce({ positions }: FitBoundsOnceProps) {
  const map = useMap();
  const hasFitted = useRef(false);
  
  useEffect(() => {
    // Only fit bounds once on initial load
    if (positions.length > 0 && !hasFitted.current) {
      hasFitted.current = true;
      if (positions.length === 1) {
        map.setView(positions[0], 14);
      } else {
        // Minimal padding for tighter framing of the mesh
        map.fitBounds(positions, { 
          padding: [15, 15],
          maxZoom: 16
        });
      }
    }
  }, [map, positions]);
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZoomToNode
// ═══════════════════════════════════════════════════════════════════════════════

interface ZoomToNodeProps {
  targetHash: string | null;
  nodeCoordinates: Map<string, [number, number]>;
  onComplete?: () => void;
}

/**
 * Zoom to a specific node and open its popup when targetHash is set.
 * Uses flyTo for smooth animation with cubic-like easing.
 */
export function ZoomToNode({ targetHash, nodeCoordinates, onComplete }: ZoomToNodeProps) {
  const map = useMap();
  const processedRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (!targetHash || targetHash === processedRef.current) return;
    
    const coords = nodeCoordinates.get(targetHash);
    if (!coords) return;
    
    processedRef.current = targetHash;
    
    // Zoom to node with smooth animation
    // easeLinearity: 0.1 creates a cubic-like ease (lower = more easing)
    map.flyTo(coords, 15, { 
      duration: 2.5,
      easeLinearity: 0.1  // Approximates easeInOutCubic
    });
    
    // After zoom completes, open the popup
    setTimeout(() => {
      // Find the marker layer and open its popup
      map.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          const pos = layer.getLatLng();
          if (Math.abs(pos.lat - coords[0]) < 0.0001 && Math.abs(pos.lng - coords[1]) < 0.0001) {
            layer.openPopup();
          }
        }
      });
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
  const map = useMap();
  
  useEffect(() => {
    if (!highlightedEdgeKey) return;
    
    // Ensure topology is visible
    onEnsureTopology();
    
    // Find the edge in either set
    const line = validatedPolylines.find(l => l.edge.key === highlightedEdgeKey) 
      || weakPolylines.find(l => l.edge.key === highlightedEdgeKey);
    
    if (!line) return;
    
    const mid: [number, number] = [
      (line.from[0] + line.to[0]) / 2,
      (line.from[1] + line.to[1]) / 2,
    ];
    
    // Smooth pan and a reasonable zoom level
    map.setView(mid, Math.max(map.getZoom(), 11), { animate: true });
  }, [highlightedEdgeKey, validatedPolylines, weakPolylines, map, onEnsureTopology]);
  
  return null;
}
