/**
 * MapLibre PathMap Component
 * 
 * Renders the packet path visualization on a MapLibre GL map.
 * Drop-in replacement for the Leaflet-based PathMap.
 * Used in PacketDetailModal to show the route a packet took.
 * 
 * Features:
 * - Node markers for each hop (styled to match ContactsMap)
 * - Path line connecting hops in order
 * - Tooltips with hop metadata
 * - Cross-highlighting with path badges
 * 
 * @module packets/PathMapMapLibre
 */

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import MapGL, { Marker, Popup, Source, Layer } from 'react-map-gl/maplibre';
import type { MapRef, LayerProps } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ResolvedPath, PathCandidate } from './PathMapVisualization';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface PathMapProps {
  resolvedPath: ResolvedPath;
  localNode?: LocalNode;
  /** Hub node hashes for visual distinction */
  hubNodes?: string[];
  /** Currently hovered hop index (for cross-highlighting with badges) */
  hoveredHopIndex?: number | null;
  /** Callback when hovering over a marker */
  onHoverHop?: (index: number | null) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants (matches ContactsMap)
// ═══════════════════════════════════════════════════════════════════════════════

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const MARKER_SIZE = 14;
const RING_THICKNESS = 5;

const DESIGN = {
  nodeColor: '#4338CA',      // Deep indigo - standard nodes
  localColor: '#4F46E5',     // Indigo-600 - local node
  hubColor: '#6366F1',       // Indigo-500 - hub nodes (filled)
  edgeColor: '#3B3F4A',      // Dark gray - path lines
  ambiguousColor: '#F9D26F', // Yellow - de-prioritized/ambiguous candidates
};

const HIGHLIGHT_COLOR = '#B49DFF'; // Lavender accent for hovered nodes
const SOURCE_COLOR = '#39D98A';    // Green for source node

// ═══════════════════════════════════════════════════════════════════════════════
// Icon Creation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create icon HTML for path nodes.
 */
function createPathNodeIconHtml(
  isLocal: boolean,
  isHub: boolean,
  isPrimary: boolean,
  isHighlighted: boolean = false,
  isSource: boolean = false
): string {
  // Highlighted nodes get a ring around them
  const highlightRing = isHighlighted 
    ? `box-shadow: 0 0 0 3px ${HIGHLIGHT_COLOR}40, 0 0 8px ${HIGHLIGHT_COLOR}60;`
    : '';
  
  // Source nodes are green, others follow normal logic
  let fillColor: string;
  if (isSource) {
    fillColor = SOURCE_COLOR;
  } else if (isLocal) {
    fillColor = DESIGN.localColor;
  } else if (isHub) {
    fillColor = DESIGN.hubColor;
  } else if (isPrimary) {
    fillColor = 'transparent';
  } else {
    fillColor = DESIGN.ambiguousColor;
  }
  
  const borderColor = (isLocal || isHub || !isPrimary || isSource) ? 'transparent' : DESIGN.nodeColor;
  const borderWidth = (isLocal || isHub || !isPrimary || isSource) ? 0 : RING_THICKNESS;
  
  return `<div style="
    width: ${MARKER_SIZE}px;
    height: ${MARKER_SIZE}px;
    background: ${fillColor};
    border-radius: 50%;
    border: ${borderWidth}px solid ${borderColor};
    box-sizing: border-box;
    transition: box-shadow 0.15s ease;
    ${highlightRing}
  "></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path Line Layer Style
// ═══════════════════════════════════════════════════════════════════════════════

const pathLineLayerStyle: LayerProps = {
  id: 'path-line',
  type: 'line',
  paint: {
    'line-color': DESIGN.edgeColor,
    'line-width': 2,
    'line-opacity': 0.7,
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
 * PathMap component - renders the MapLibre map with path visualization.
 */
export default function PathMapMapLibre({ 
  resolvedPath, 
  localNode, 
  hubNodes = [],
  hoveredHopIndex,
  onHoverHop,
}: PathMapProps) {
  const mapRef = useRef<MapRef>(null);
  const hubSet = useMemo(() => new Set(hubNodes), [hubNodes]);
  const [popupInfo, setPopupInfo] = useState<{
    longitude: number;
    latitude: number;
    marker: MarkerData;
  } | null>(null);
  
  // Build positions and markers from resolved path
  interface MarkerData {
    position: [number, number]; // [lat, lng]
    prefix: string;
    confidence: number;
    candidateCount: number;
    hopIndex: number;
    candidate: PathCandidate;
    isHub: boolean;
    isPrimary: boolean;
    isSource: boolean;
  }
  
  const { positions, markers, pathLineGeoJSON } = useMemo(() => {
    const positions: [number, number][] = [];
    const markers: MarkerData[] = [];
    const pathLineCoords: [number, number][] = []; // [lng, lat] for GeoJSON
    
    resolvedPath.hops.forEach((hop, hopIndex) => {
      if (hop.candidates.length === 0) return;
      
      // Sort candidates by probability (highest first)
      const sortedCandidates = [...hop.candidates].sort((a, b) => b.probability - a.probability);
      
      // For path line, use the most likely candidate
      const primaryCandidate = sortedCandidates[0];
      // GeoJSON uses [lng, lat] format
      pathLineCoords.push([primaryCandidate.longitude, primaryCandidate.latitude]);
      
      // Check if this is a source hop
      const isSourceHop = 'isSource' in hop && hop.isSource === true;
      
      // Add markers for all candidates
      hop.candidates.forEach((candidate, candidateIndex) => {
        const pos: [number, number] = [candidate.latitude, candidate.longitude];
        positions.push(pos);
        const isPrimary = candidateIndex === 0;
        markers.push({
          position: pos,
          prefix: hop.prefix,
          confidence: hop.confidence,
          candidateCount: hop.candidates.length,
          hopIndex,
          candidate,
          isHub: hubSet.has(candidate.hash),
          isPrimary,
          isSource: isSourceHop,
        });
      });
    });
    
    // Build GeoJSON for path line
    const pathLineGeoJSON: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
      type: 'FeatureCollection',
      features: pathLineCoords.length >= 2 ? [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: pathLineCoords,
        },
      }] : [],
    };
    
    return { positions, markers, pathLineGeoJSON };
  }, [resolvedPath, hubSet]);
  
  // Calculate center and zoom
  const { center, zoom } = useMemo(() => {
    if (positions.length === 0) {
      if (localNode) {
        return { center: [localNode.longitude, localNode.latitude] as [number, number], zoom: 10 };
      }
      return { center: [0, 0] as [number, number], zoom: 2 };
    }
    
    // Calculate bounds
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    
    for (const [lat, lng] of positions) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    
    // Estimate zoom level based on bounds
    const latDiff = maxLat - minLat;
    const lngDiff = maxLng - minLng;
    const maxDiff = Math.max(latDiff, lngDiff);
    
    let zoom: number;
    if (maxDiff < 0.01) zoom = 15;
    else if (maxDiff < 0.05) zoom = 13;
    else if (maxDiff < 0.1) zoom = 12;
    else if (maxDiff < 0.5) zoom = 10;
    else if (maxDiff < 1) zoom = 9;
    else if (maxDiff < 5) zoom = 7;
    else zoom = 5;
    
    return { center: [centerLng, centerLat] as [number, number], zoom };
  }, [positions, localNode]);
  
  // Fit bounds on load
  useEffect(() => {
    if (!mapRef.current || positions.length < 2) return;
    
    // Calculate bounds for fitBounds
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    
    for (const [lat, lng] of positions) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    
    // Add padding
    const padding = 30;
    
    mapRef.current.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      { padding, maxZoom: 16, duration: 0 }
    );
  }, [positions]);
  
  // Event handlers
  const handleMarkerClick = useCallback((marker: MarkerData) => {
    setPopupInfo({
      longitude: marker.position[1], // lng
      latitude: marker.position[0], // lat
      marker,
    });
  }, []);
  
  if (positions.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-text-muted text-sm bg-bg-elevated">
        No mappable path data
      </div>
    );
  }
  
  return (
    <MapGL
      ref={mapRef}
      initialViewState={{
        longitude: center[0],
        latitude: center[1],
        zoom,
      }}
      style={{ height: '200px', width: '100%' }}
      mapStyle={MAP_STYLE}
      attributionControl={false}
    >
      {/* Path line (rendered first, underneath markers) */}
      {pathLineGeoJSON.features.length > 0 && (
        <Source id="path-line-source" type="geojson" data={pathLineGeoJSON}>
          <Layer {...pathLineLayerStyle} />
        </Source>
      )}
      
      {/* Path markers */}
      {markers.map((marker) => {
        const isHighlighted = hoveredHopIndex === marker.hopIndex;
        
        return (
          <Marker
            key={`${marker.hopIndex}-${marker.candidate.hash}`}
            longitude={marker.position[1]} // lng
            latitude={marker.position[0]} // lat
            anchor="center"
            onClick={() => handleMarkerClick(marker)}
          >
            <div
              style={{ 
                cursor: 'pointer',
                opacity: marker.isPrimary ? 1 : 0.5,
              }}
              onMouseEnter={() => onHoverHop?.(marker.hopIndex)}
              onMouseLeave={() => onHoverHop?.(null)}
              dangerouslySetInnerHTML={{ 
                __html: createPathNodeIconHtml(
                  marker.candidate.isLocal || false,
                  marker.isHub,
                  marker.isPrimary,
                  isHighlighted,
                  marker.isSource
                )
              }}
            />
          </Marker>
        );
      })}
      
      {/* Popup */}
      {popupInfo && (
        <Popup
          longitude={popupInfo.longitude}
          latitude={popupInfo.latitude}
          anchor="bottom"
          offset={[0, -12] as [number, number]}
          closeOnClick={false}
          onClose={() => setPopupInfo(null)}
          className="maplibre-popup"
        >
          <div className="text-xs">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold">{popupInfo.marker.candidate.name}</span>
              {popupInfo.marker.isSource && (
                <span 
                  className="px-1 py-0.5 text-[8px] font-bold rounded"
                  style={{ backgroundColor: SOURCE_COLOR, color: '#000' }}
                >SRC</span>
              )}
              {popupInfo.marker.isHub && (
                <span 
                  className="px-1 py-0.5 text-[8px] font-bold rounded"
                  style={{ backgroundColor: '#FBBF24', color: '#000' }}
                >HUB</span>
              )}
              {popupInfo.marker.candidate.isLocal && (
                <span 
                  className="px-1 py-0.5 text-[8px] font-bold rounded"
                  style={{ backgroundColor: DESIGN.localColor, color: '#fff' }}
                >LOCAL</span>
              )}
            </div>
            <div className="text-text-muted font-mono text-[10px]">
              {popupInfo.marker.prefix} • {popupInfo.marker.candidate.hash.slice(0, 10)}...
            </div>
            {!popupInfo.marker.isPrimary && popupInfo.marker.candidateCount > 1 && (
              <div style={{ color: DESIGN.ambiguousColor }}>
                Alternative ({(popupInfo.marker.candidate.probability * 100).toFixed(0)}%)
              </div>
            )}
            {popupInfo.marker.isPrimary && popupInfo.marker.candidateCount > 1 && (
              <div className="text-text-muted">
                {popupInfo.marker.candidateCount} candidates
              </div>
            )}
          </div>
        </Popup>
      )}
    </MapGL>
  );
}
