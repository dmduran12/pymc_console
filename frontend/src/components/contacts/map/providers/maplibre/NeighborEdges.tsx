/**
 * MapLibre NeighborEdges Layer Component
 * 
 * Renders dashed lines from local node to zero-hop (direct RF) neighbors.
 * These are ALWAYS visible - not gated by topology toggle.
 * Direct port from Leaflet version - maintains exact visual parity.
 * 
 * Features:
 * - Dashed gray lines at rest, yellow on hover (matches home icon semantic)
 * - Tooltips with RSSI/SNR data from direct RF packets
 * - Signal quality data from lastHopNeighbors (topology-computed averages)
 * 
 * @module providers/maplibre/NeighborEdges
 */

import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/maplibre';
import type { LayerProps } from 'react-map-gl/maplibre';
import type { NeighborInfo } from '@/types/api';
import type { LastHopNeighbor } from '@/lib/mesh-topology';
import { DESIGN } from '../../constants';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface NeighborPolylineData {
  from: [number, number];
  to: [number, number];
  hash: string;
  neighbor: NeighborInfo;
  lastHopData: LastHopNeighbor | null;
}

export interface NeighborEdgesProps {
  /** Neighbor polylines to render */
  neighborPolylines: NeighborPolylineData[];
  /** Currently hovered edge key */
  hoveredEdgeKey: string | null;
  /** Callback when edge hover state changes */
  onEdgeHover: (key: string | null) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GeoJSON Builder
// ═══════════════════════════════════════════════════════════════════════════════

interface NeighborEdgeProperties {
  key: string;
  hash: string;
  name: string;
  prefix?: string;
  rssi?: number | null;
  snr?: number | null;
  packetCount?: number;
  confidence?: number;
  hasAvgRssi: boolean;
  hasAvgSnr: boolean;
  color: string;
  width: number;
  opacity: number;
}

// Convert [lat, lng] to GeoJSON [lng, lat]
function toGeoJSON(coord: [number, number]): [number, number] {
  return [coord[1], coord[0]];
}

/**
 * Build GeoJSON for neighbor edges.
 */
function buildNeighborEdgesGeoJSON(
  neighborPolylines: NeighborPolylineData[],
  hoveredEdgeKey: string | null
): GeoJSON.FeatureCollection<GeoJSON.LineString, NeighborEdgeProperties> {
  const features: GeoJSON.Feature<GeoJSON.LineString, NeighborEdgeProperties>[] = [];
  
  for (const { from, to, hash, neighbor, lastHopData } of neighborPolylines) {
    const name = neighbor.node_name || neighbor.name || hash.slice(0, 8);
    
    // Prefer topology-computed RSSI/SNR (averaged from actual packets) over API snapshot
    const snr = lastHopData?.avgSnr ?? neighbor.snr;
    const rssi = lastHopData?.avgRssi ?? neighbor.rssi;
    const packetCount = lastHopData?.count;
    const confidence = lastHopData?.confidence;
    
    // Hover state: gray at rest, yellow on hover (matches home icon semantic)
    const neighborEdgeKey = `neighbor-${hash}`;
    const isNeighborHovered = hoveredEdgeKey === neighborEdgeKey;
    const neighborColor = isNeighborHovered ? DESIGN.edges.neighborHover : DESIGN.edges.neighborRest;
    const neighborWeight = isNeighborHovered ? 2.5 : 1.5;
    const neighborOpacity = isNeighborHovered ? 1 : 0.6;
    
    features.push({
      type: 'Feature',
      properties: {
        key: neighborEdgeKey,
        hash,
        name,
        prefix: lastHopData?.prefix,
        rssi,
        snr,
        packetCount,
        confidence,
        hasAvgRssi: lastHopData?.avgRssi !== undefined,
        hasAvgSnr: lastHopData?.avgSnr !== undefined,
        color: neighborColor,
        width: neighborWeight,
        opacity: neighborOpacity,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          toGeoJSON(from),
          toGeoJSON(to),
        ],
      },
    });
  }
  
  return { type: 'FeatureCollection', features };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer Style
// ═══════════════════════════════════════════════════════════════════════════════

const neighborEdgesLayerStyle: LayerProps = {
  id: 'neighbor-edges',
  type: 'line',
  paint: {
    'line-color': ['get', 'color'],
    'line-width': ['get', 'width'],
    'line-opacity': ['get', 'opacity'],
    'line-dasharray': [4, 4],
  },
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
};

// Invisible hit-area layer for better neighbor edge interactivity
const neighborEdgesHitAreaStyle: LayerProps = {
  id: 'neighbor-edges-hitarea',
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

/**
 * Renders neighbor edges as dashed lines from local to zero-hop neighbors.
 * Always visible regardless of topology toggle state.
 */
export function NeighborEdges({
  neighborPolylines,
  hoveredEdgeKey,
  onEdgeHover: _onEdgeHover, // Hover handled at map level now
}: NeighborEdgesProps) {
  // Whether we have data to render
  const hasData = neighborPolylines.length > 0;
  
  // Build GeoJSON data (always call hooks to maintain consistent order)
  const neighborEdgesData = useMemo(
    () => hasData ? buildNeighborEdgesGeoJSON(neighborPolylines, hoveredEdgeKey) : { type: 'FeatureCollection' as const, features: [] },
    [neighborPolylines, hoveredEdgeKey, hasData]
  );
  
  // Early return after all hooks
  if (!hasData) {
    return null;
  }
  
  return (
    <Source id="neighbor-edges" type="geojson" data={neighborEdgesData}>
      {/* Hit-area layer (invisible, wider for easy hover detection) - rendered first (below) */}
      <Layer {...neighborEdgesHitAreaStyle} />
      {/* Visual layer */}
      <Layer {...neighborEdgesLayerStyle} />
      {/* Note: Tooltips handled at map level for proper interactivity */}
    </Source>
  );
}

// Export types and constants needed by parent
export type { NeighborEdgeProperties };

// Layer IDs for interactiveLayerIds
export const NEIGHBOR_EDGE_LAYER_IDS = [
  'neighbor-edges-hitarea',
  'neighbor-edges',
] as const;
