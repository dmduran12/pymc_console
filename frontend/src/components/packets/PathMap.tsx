import { useMemo, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { ResolvedPath, PathCandidate } from './PathMapVisualization';

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
}

// ═══════════════════════════════════════════════════════════════════════════════
// Design System Constants (matches ContactsMap)
// ═══════════════════════════════════════════════════════════════════════════════

// Marker size (matches ContactsMap)
const MARKER_SIZE = 14;
const RING_THICKNESS = 5;

// Design palette (matches ContactsMap)
const DESIGN = {
  nodeColor: '#4338CA',      // Deep indigo - standard nodes
  localColor: '#4F46E5',     // Indigo-600 - local node
  hubColor: '#6366F1',       // Indigo-500 - hub nodes (filled)
  edgeColor: '#3B3F4A',      // Dark gray - path lines (matches ContactsMap)
  ambiguousColor: '#F9D26F', // Yellow - de-prioritized/ambiguous candidates
};

/**
 * Create a simple ring/filled icon for path nodes.
 * No confidence stroke - disambiguation shown via color and opacity.
 * 
 * @param isLocal - Whether this is the local node
 * @param isHub - Whether this is a hub node
 * @param isPrimary - Whether this is the primary (most likely) candidate
 */
function createPathNodeIcon(
  isLocal: boolean,
  isHub: boolean,
  isPrimary: boolean
): L.DivIcon {
  // Primary candidates use standard colors, secondary use yellow
  const fillColor = isLocal 
    ? DESIGN.localColor 
    : isHub 
      ? DESIGN.hubColor 
      : isPrimary 
        ? 'transparent' 
        : DESIGN.ambiguousColor;
  
  const borderColor = (isLocal || isHub || !isPrimary) ? 'transparent' : DESIGN.nodeColor;
  const borderWidth = (isLocal || isHub || !isPrimary) ? 0 : RING_THICKNESS;
  
  return L.divIcon({
    className: 'path-node-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background: ${fillColor};
      border-radius: 50%;
      border: ${borderWidth}px solid ${borderColor};
      box-sizing: border-box;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
  });
}

/**
 * Component to fit map bounds to show all path nodes
 */
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const hasFitted = useRef(false);
  
  useEffect(() => {
    if (positions.length > 0 && !hasFitted.current) {
      hasFitted.current = true;
      if (positions.length === 1) {
        // Single point - zoom in close
        map.setView(positions[0], 15);
      } else {
        // Multiple points - fit bounds with minimal padding (matches ContactsMap)
        map.fitBounds(positions, { 
          padding: [15, 15], 
          maxZoom: 16,
        });
      }
    }
  }, [map, positions]);
  
  return null;
}

/**
 * Path line component - matches ContactsMap edge styling
 */
function PathLine({ positions }: { positions: [number, number][] }) {
  if (positions.length < 2) return null;
  
  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: DESIGN.edgeColor,
        weight: 2,
        opacity: 0.7,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  );
}

/**
 * PathMap component - renders the Leaflet map with path visualization
 * Styled to match ContactsMap (ring markers, subtle edges)
 */
export default function PathMap({ resolvedPath, localNode, hubNodes = [] }: PathMapProps) {
  const hubSet = useMemo(() => new Set(hubNodes), [hubNodes]);
  
  // Build positions and markers from resolved path
  const { positions, markers, pathLine } = useMemo(() => {
    const positions: [number, number][] = [];
    const markers: Array<{
      position: [number, number];
      prefix: string;
      confidence: number;
      candidateCount: number;
      hopIndex: number;
      candidate: PathCandidate;
      isHub: boolean;
      isPrimary: boolean;
    }> = [];
    const pathLine: [number, number][] = [];
    
    resolvedPath.hops.forEach((hop, hopIndex) => {
      if (hop.candidates.length === 0) return;
      
      // Sort candidates by probability (highest first)
      const sortedCandidates = [...hop.candidates].sort((a, b) => b.probability - a.probability);
      
      // For path line, use the most likely candidate
      const primaryCandidate = sortedCandidates[0];
      pathLine.push([primaryCandidate.latitude, primaryCandidate.longitude]);
      
      // Add markers for all candidates
      // Primary candidate (highest probability) gets full styling, others get yellow + low opacity
      hop.candidates.forEach((candidate, candidateIndex) => {
        const pos: [number, number] = [candidate.latitude, candidate.longitude];
        positions.push(pos);
        const isPrimary = candidateIndex === 0; // First in sorted list is primary
        markers.push({
          position: pos,
          prefix: hop.prefix,
          confidence: hop.confidence,
          candidateCount: hop.candidates.length,
          hopIndex,
          candidate,
          isHub: hubSet.has(candidate.hash),
          isPrimary,
        });
      });
    });
    
    return { positions, markers, pathLine };
  }, [resolvedPath, hubSet]);
  
  // Calculate center
  const center: [number, number] = useMemo(() => {
    if (positions.length > 0) {
      const sumLat = positions.reduce((s, p) => s + p[0], 0);
      const sumLng = positions.reduce((s, p) => s + p[1], 0);
      return [sumLat / positions.length, sumLng / positions.length];
    }
    if (localNode) {
      return [localNode.latitude, localNode.longitude];
    }
    return [0, 0];
  }, [positions, localNode]);
  
  if (positions.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-text-muted text-sm bg-bg-elevated">
        No mappable path data
      </div>
    );
  }
  
  return (
    <MapContainer
      center={center}
      zoom={10}
      style={{ height: '200px', width: '100%', background: '#0d1520' }}
      attributionControl={false}
      zoomControl={false}
      className="map-blue-water"
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        className="map-tiles-blue-tint"
      />
      
      <FitBounds positions={positions} />
      
      {/* Path line */}
      <PathLine positions={pathLine} />
      
      {/* Markers for each hop */}
      {markers.map((marker) => (
        <Marker
          key={`${marker.hopIndex}-${marker.candidate.hash}`}
          position={marker.position}
          icon={createPathNodeIcon(
            marker.candidate.isLocal || false,
            marker.isHub,
            marker.isPrimary
          )}
          opacity={marker.isPrimary ? 1 : 0.5} // Secondary candidates at 50% opacity
        >
          <Tooltip
            permanent={false}
            direction="top"
            offset={[0, -12]}
          >
            <div className="text-xs">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">{marker.candidate.name}</span>
                {marker.isHub && (
                  <span 
                    className="px-1 py-0.5 text-[8px] font-bold rounded"
                    style={{ backgroundColor: '#FBBF24', color: '#000' }}
                  >HUB</span>
                )}
                {marker.candidate.isLocal && (
                  <span 
                    className="px-1 py-0.5 text-[8px] font-bold rounded"
                    style={{ backgroundColor: DESIGN.localColor, color: '#fff' }}
                  >LOCAL</span>
                )}
              </div>
              <div className="text-text-muted font-mono text-[10px]">
                {marker.prefix} • {marker.candidate.hash.slice(0, 10)}...
              </div>
              {!marker.isPrimary && marker.candidateCount > 1 && (
                <div style={{ color: DESIGN.ambiguousColor }}>
                  Alternative ({(marker.candidate.probability * 100).toFixed(0)}%)
                </div>
              )}
              {marker.isPrimary && marker.candidateCount > 1 && (
                <div className="text-text-muted">
                  {marker.candidateCount} candidates
                </div>
              )}
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
