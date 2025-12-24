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

import { useMemo, useState, useCallback } from 'react';
import { Source, Layer, Popup } from 'react-map-gl/maplibre';
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
          [from[1], from[0]], // [lng, lat]
          [to[1], to[0]],
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

// ═══════════════════════════════════════════════════════════════════════════════
// Tooltip Content Component
// ═══════════════════════════════════════════════════════════════════════════════

interface NeighborTooltipContentProps {
  name: string;
  prefix?: string;
  rssi?: number | null;
  snr?: number | null;
  packetCount?: number;
  confidence?: number;
  hasAvgRssi: boolean;
  hasAvgSnr: boolean;
}

function NeighborTooltipContent({
  name,
  prefix,
  rssi,
  snr,
  packetCount,
  confidence,
  hasAvgRssi,
  hasAvgSnr,
}: NeighborTooltipContentProps) {
  return (
    <div className="text-xs">
      <div className="font-medium text-text-primary">
        <span className="text-amber-400">●</span> {name}
        {prefix && (
          <span className="ml-1 text-text-muted font-mono text-[10px]">
            ({prefix})
          </span>
        )}
      </div>
      
      <div className="text-text-secondary flex gap-2">
        {rssi !== undefined && rssi !== null && (
          <span>RSSI: {Math.round(rssi)} dBm{hasAvgRssi && ' avg'}</span>
        )}
        {snr !== undefined && snr !== null && (
          <span>SNR: {snr.toFixed(1)} dB{hasAvgSnr && ' avg'}</span>
        )}
      </div>
      
      {packetCount !== undefined && (
        <div className="text-text-muted text-[10px]">
          {packetCount.toLocaleString()} packets
          {confidence !== undefined && ` • ${Math.round(confidence * 100)}% conf`}
        </div>
      )}
      
      <div className="text-amber-400 text-[10px] mt-0.5">Direct RF neighbor</div>
    </div>
  );
}

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
  onEdgeHover,
}: NeighborEdgesProps) {
  // Tooltip state
  const [tooltipInfo, setTooltipInfo] = useState<{
    longitude: number;
    latitude: number;
    properties: NeighborEdgeProperties;
  } | null>(null);
  
  // Whether we have data to render
  const hasData = neighborPolylines.length > 0;
  
  // Build GeoJSON data (always call hooks to maintain consistent order)
  const neighborEdgesData = useMemo(
    () => hasData ? buildNeighborEdgesGeoJSON(neighborPolylines, hoveredEdgeKey) : { type: 'FeatureCollection' as const, features: [] },
    [neighborPolylines, hoveredEdgeKey, hasData]
  );
  
  // Mouse event handlers for edges (to be wired up at Map level)
  const _handleMouseEnter = useCallback((e: maplibregl.MapLayerMouseEvent) => {
    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      const props = feature.properties as NeighborEdgeProperties;
      onEdgeHover(props.key);
      
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
  void _handleMouseEnter;
  void _handleMouseLeave;
  
  // Early return after all hooks
  if (!hasData) {
    return null;
  }
  
  return (
    <>
      <Source id="neighbor-edges" type="geojson" data={neighborEdgesData}>
        <Layer {...neighborEdgesLayerStyle} />
      </Source>
      
      {/* ─── NEIGHBOR TOOLTIP ───────────────────────────────────────────────── */}
      {tooltipInfo && (
        <Popup
          longitude={tooltipInfo.longitude}
          latitude={tooltipInfo.latitude}
          anchor="bottom"
          closeButton={false}
          closeOnClick={false}
          className="topology-edge-tooltip maplibre-popup"
        >
          <NeighborTooltipContent
            name={tooltipInfo.properties.name}
            prefix={tooltipInfo.properties.prefix}
            rssi={tooltipInfo.properties.rssi}
            snr={tooltipInfo.properties.snr}
            packetCount={tooltipInfo.properties.packetCount}
            confidence={tooltipInfo.properties.confidence}
            hasAvgRssi={tooltipInfo.properties.hasAvgRssi}
            hasAvgSnr={tooltipInfo.properties.hasAvgSnr}
          />
        </Popup>
      )}
    </>
  );
}

// Export types needed by parent
export type { NeighborEdgeProperties };
