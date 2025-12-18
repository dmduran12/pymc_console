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
}

// Colors for path visualization
const PATH_COLORS = {
  exact: '#39D98A',      // Green - exact match
  multi: '#F9D26F',      // Yellow - multiple candidates  
  unknown: '#767688',    // Gray - no candidates
  line: '#B49DFF',       // Lavender - path line
  localNode: '#60A5FA',  // Blue - local node
};

/**
 * Create a labeled marker icon showing the prefix
 */
function createPrefixIcon(
  prefix: string,
  confidence: number,
  hopIndex: number,
  isLocal: boolean = false
): L.DivIcon {
  const color = isLocal
    ? PATH_COLORS.localNode
    : confidence >= 1
    ? PATH_COLORS.exact
    : confidence > 0
    ? PATH_COLORS.multi
    : PATH_COLORS.unknown;
  
  return L.divIcon({
    className: 'path-marker',
    html: `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        transform: translate(-50%, -50%);
      ">
        <div style="
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          font-weight: 600;
          color: white;
          background: ${color};
          padding: 2px 4px;
          border-radius: 3px;
          white-space: nowrap;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        ">${hopIndex + 1}. ${prefix}</div>
        <div style="
          width: 12px;
          height: 12px;
          background: ${color};
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.8);
          margin-top: 2px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        "></div>
      </div>
    `,
    iconSize: [40, 30],
    iconAnchor: [20, 30],
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
        map.setView(positions[0], 12);
      } else {
        map.fitBounds(positions, { padding: [30, 30], maxZoom: 14 });
      }
    }
  }, [map, positions]);
  
  return null;
}

/**
 * Animated path line component
 */
function AnimatedPathLine({ positions }: { positions: [number, number][] }) {
  if (positions.length < 2) return null;
  
  return (
    <>
      {/* Background line */}
      <Polyline
        positions={positions}
        color={PATH_COLORS.line}
        weight={3}
        opacity={0.3}
      />
      {/* Animated dashed line */}
      <Polyline
        positions={positions}
        color={PATH_COLORS.line}
        weight={2}
        opacity={0.8}
        dashArray="8, 8"
        dashOffset="0"
      />
    </>
  );
}

/**
 * PathMap component - renders the Leaflet map with path visualization
 */
export default function PathMap({ resolvedPath, localNode }: PathMapProps) {
  // Build positions and markers from resolved path
  const { positions, markers, pathLine } = useMemo(() => {
    const positions: [number, number][] = [];
    const markers: Array<{
      position: [number, number];
      prefix: string;
      confidence: number;
      hopIndex: number;
      candidate: PathCandidate;
    }> = [];
    const pathLine: [number, number][] = [];
    
    resolvedPath.hops.forEach((hop, hopIndex) => {
      if (hop.candidates.length === 0) return;
      
      // For path line, use the most likely candidate (first one)
      const primaryCandidate = hop.candidates[0];
      pathLine.push([primaryCandidate.latitude, primaryCandidate.longitude]);
      
      // Add markers for all candidates (with opacity based on probability)
      hop.candidates.forEach(candidate => {
        const pos: [number, number] = [candidate.latitude, candidate.longitude];
        positions.push(pos);
        markers.push({
          position: pos,
          prefix: hop.prefix,
          confidence: hop.confidence,
          hopIndex,
          candidate,
        });
      });
    });
    
    return { positions, markers, pathLine };
  }, [resolvedPath]);
  
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
      <AnimatedPathLine positions={pathLine} />
      
      {/* Markers for each hop */}
      {markers.map((marker) => (
        <Marker
          key={`${marker.hopIndex}-${marker.candidate.hash}`}
          position={marker.position}
          icon={createPrefixIcon(
            marker.prefix,
            marker.confidence,
            marker.hopIndex,
            marker.candidate.isLocal
          )}
          opacity={marker.candidate.probability}
        >
          <Tooltip
            permanent={false}
            direction="top"
            offset={[0, -20]}
          >
            <div className="text-xs">
              <div className="font-semibold">{marker.candidate.name}</div>
              <div className="text-text-muted font-mono text-[10px]">
                {marker.candidate.hash.slice(0, 8)}...
              </div>
              {marker.candidate.probability < 1 && (
                <div className="text-accent-secondary">
                  {(marker.candidate.probability * 100).toFixed(0)}% likely
                </div>
              )}
              {marker.candidate.isLocal && (
                <div className="text-accent-tertiary">Local Node</div>
              )}
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
