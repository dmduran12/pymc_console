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
  edgeColor: '#3B3F4A',      // Dark gray - path lines
  
  // Confidence stroke colors
  confidenceExact: '#39D98A',    // Green - 100% (unique match)
  confidenceHigh: '#F9D26F',     // Yellow - 50-99%
  confidenceMedium: '#FF8A5C',   // Orange - 25-49%
  confidenceLow: '#FF5C7A',      // Red - 1-24%
  confidenceUnknown: '#767688',  // Gray - 0%
};

/**
 * Get stroke color based on confidence level.
 */
function getConfidenceStrokeColor(confidence: number, candidateCount: number): string {
  if (candidateCount === 0) return DESIGN.confidenceUnknown;
  if (confidence >= 1) return DESIGN.confidenceExact;
  if (confidence >= 0.5) return DESIGN.confidenceHigh;
  if (confidence >= 0.25) return DESIGN.confidenceMedium;
  if (confidence > 0) return DESIGN.confidenceLow;
  return DESIGN.confidenceUnknown;
}

/**
 * Create a ring icon with a confidence stroke indicator.
 * Ring color is node type, stroke color indicates confidence.
 */
function createConfidenceRingIcon(
  confidence: number,
  candidateCount: number,
  isLocal: boolean,
  isHub: boolean
): L.DivIcon {
  const strokeColor = getConfidenceStrokeColor(confidence, candidateCount);
  const fillColor = isLocal ? DESIGN.localColor : isHub ? DESIGN.hubColor : 'transparent';
  const borderColor = isLocal || isHub ? 'transparent' : DESIGN.nodeColor;
  const borderWidth = isLocal || isHub ? 0 : RING_THICKNESS;
  
  // For local/hub: filled circle with confidence stroke
  // For standard: ring with confidence stroke
  return L.divIcon({
    className: 'path-confidence-marker',
    html: `<div style="
      width: ${MARKER_SIZE + 4}px;
      height: ${MARKER_SIZE + 4}px;
      position: relative;
    ">
      <!-- Confidence stroke (outer ring) -->
      <div style="
        position: absolute;
        top: 0;
        left: 0;
        width: ${MARKER_SIZE + 4}px;
        height: ${MARKER_SIZE + 4}px;
        border-radius: 50%;
        border: 2px solid ${strokeColor};
        box-sizing: border-box;
      "></div>
      <!-- Node marker (inner) -->
      <div style="
        position: absolute;
        top: 2px;
        left: 2px;
        width: ${MARKER_SIZE}px;
        height: ${MARKER_SIZE}px;
        background: ${fillColor};
        border-radius: 50%;
        border: ${borderWidth}px solid ${borderColor};
        box-sizing: border-box;
      "></div>
    </div>`,
    iconSize: [MARKER_SIZE + 4, MARKER_SIZE + 4],
    iconAnchor: [(MARKER_SIZE + 4) / 2, (MARKER_SIZE + 4) / 2],
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
    }> = [];
    const pathLine: [number, number][] = [];
    
    resolvedPath.hops.forEach((hop, hopIndex) => {
      if (hop.candidates.length === 0) return;
      
      // Sort candidates by probability (highest first)
      const sortedCandidates = [...hop.candidates].sort((a, b) => b.probability - a.probability);
      
      // For path line, use the most likely candidate
      const primaryCandidate = sortedCandidates[0];
      pathLine.push([primaryCandidate.latitude, primaryCandidate.longitude]);
      
      // Add markers for all candidates (with opacity based on probability)
      hop.candidates.forEach(candidate => {
        const pos: [number, number] = [candidate.latitude, candidate.longitude];
        positions.push(pos);
        markers.push({
          position: pos,
          prefix: hop.prefix,
          confidence: hop.confidence,
          candidateCount: hop.candidates.length,
          hopIndex,
          candidate,
          isHub: hubSet.has(candidate.hash),
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
          icon={createConfidenceRingIcon(
            marker.confidence,
            marker.candidateCount,
            marker.candidate.isLocal || false,
            marker.isHub
          )}
          opacity={Math.max(0.5, marker.candidate.probability)} // Min opacity for visibility
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
              {marker.candidate.probability < 1 && marker.candidateCount > 1 && (
                <div style={{ color: getConfidenceStrokeColor(marker.confidence, marker.candidateCount) }}>
                  {(marker.candidate.probability * 100).toFixed(0)}% confidence
                </div>
              )}
              {marker.candidateCount === 1 && (
                <div style={{ color: DESIGN.confidenceExact }}>
                  Exact match
                </div>
              )}
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
