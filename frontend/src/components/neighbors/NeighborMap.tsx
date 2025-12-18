import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { HashBadge } from '@/components/ui/HashBadge';

// Create a matte dot icon with CSS shadows
function createDotIcon(color: string, size: number, isHovered: boolean = false): L.DivIcon {
  const scale = isHovered ? 1.25 : 1;
  const actualSize = size * scale;
  
  return L.divIcon({
    className: 'map-dot-marker',
    html: `<div style="
      width: ${actualSize}px;
      height: ${actualSize}px;
      background-color: ${color};
      border-radius: 50%;
      border: 0.75px solid rgba(13, 14, 18, 0.6);
      box-shadow: 0 2px 3px rgba(0, 0, 0, 0.08), inset 0 -2px 3px rgba(0, 0, 0, 0.06)${isHovered ? `, 0 0 12px ${color}` : ''};
      transition: all 0.15s ease-out;
      opacity: ${isHovered ? 1 : 0.9};
      filter: brightness(${isHovered ? 1.1 : 1});
    "></div>`,
    iconSize: [actualSize, actualSize],
    iconAnchor: [actualSize / 2, actualSize / 2],
    popupAnchor: [0, -actualSize / 2],
  });
}

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface NeighborMapProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
  packets?: Packet[];
  onRemoveNode?: (hash: string) => void;
}

// Signal color constants from CSS variables (computed for map use)
const SIGNAL_COLORS = {
  excellent: '#4CFFB5',  // --signal-excellent
  good: '#39D98A',       // --signal-good
  fair: '#F9D26F',       // --signal-fair
  poor: '#FF8A5C',       // --signal-poor
  critical: '#FF5C7A',   // --signal-critical
  unknown: '#767688',    // --signal-unknown
  localNode: '#60A5FA',  // --map-local-node
};

// Calculate mean SNR from packets for a given source hash
function calculateMeanSnr(packets: Packet[], srcHash: string): number | undefined {
  const nodePackets = packets.filter(p => p.src_hash === srcHash && p.snr !== undefined);
  if (nodePackets.length === 0) return undefined;
  
  const sum = nodePackets.reduce((acc, p) => acc + (p.snr ?? 0), 0);
  return sum / nodePackets.length;
}

// Get color based on signal strength (SNR is more reliable than RSSI for LoRa)
function getSignalColor(snr?: number): string {
  if (snr === undefined) return SIGNAL_COLORS.unknown;
  if (snr >= 5) return SIGNAL_COLORS.excellent;
  if (snr >= 0) return SIGNAL_COLORS.good;
  if (snr >= -5) return SIGNAL_COLORS.fair;
  if (snr >= -10) return SIGNAL_COLORS.poor;
  return SIGNAL_COLORS.critical;
}

// Parse paths from packets to infer mesh connections
function inferMeshConnections(packets: Packet[]): Map<string, Set<string>> {
  const connections = new Map<string, Set<string>>();
  
  const addConnection = (from: string, to: string) => {
    if (!connections.has(from)) connections.set(from, new Set());
    if (!connections.has(to)) connections.set(to, new Set());
    connections.get(from)!.add(to);
    connections.get(to)!.add(from); // Bidirectional
  };
  
  for (const packet of packets) {
    // Parse forwarded_path or original_path
    const path = packet.forwarded_path ?? packet.original_path;
    if (!path || !Array.isArray(path) || path.length < 2) continue;
    
    // Each consecutive pair in the path represents a connection
    for (let i = 0; i < path.length - 1; i++) {
      addConnection(path[i], path[i + 1]);
    }
  }
  
  return connections;
}

// Component to fit bounds only on initial load (not when user navigates)
function FitBoundsOnce({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const hasFitted = useRef(false);
  
  useEffect(() => {
    // Only fit bounds once on initial load
    if (positions.length > 0 && !hasFitted.current) {
      hasFitted.current = true;
      if (positions.length === 1) {
        map.setView(positions[0], 13);
      } else {
        // Tighter padding for better initial framing of the mesh
        map.fitBounds(positions, { 
          padding: [40, 40],
          maxZoom: 14
        });
      }
    }
  }, [map, positions]);
  
  return null;
}

export default function NeighborMap({ neighbors, localNode, packets = [], onRemoveNode }: NeighborMapProps) {
  // Track hover state per marker
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  
  // Filter neighbors with valid coordinates
  const neighborsWithLocation = useMemo(() => {
    return Object.entries(neighbors).filter(([, neighbor]) => {
      const lat = neighbor.latitude;
      const lng = neighbor.longitude;
      return lat !== undefined && lng !== undefined && lat !== 0 && lng !== 0;
    });
  }, [neighbors]);
  
  // Build a map of hash -> coordinates for mesh connections
  const nodeCoordinates = useMemo(() => {
    const coords = new Map<string, [number, number]>();
    
    if (localNode && localNode.latitude && localNode.longitude) {
      // Local node uses public key hash from stats - we'll try matching with neighbor hashes
      coords.set('local', [localNode.latitude, localNode.longitude]);
    }
    
    neighborsWithLocation.forEach(([hash, neighbor]) => {
      if (neighbor.latitude && neighbor.longitude) {
        coords.set(hash, [neighbor.latitude, neighbor.longitude]);
      }
    });
    
    return coords;
  }, [neighborsWithLocation, localNode]);
  
  // Infer mesh connections from packet paths
  const meshConnections = useMemo(() => {
    return inferMeshConnections(packets);
  }, [packets]);
  
  // Generate polylines for mesh connections (only where we have coordinates for both endpoints)
  const meshPolylines = useMemo(() => {
    const lines: Array<{ from: [number, number]; to: [number, number]; key: string }> = [];
    const drawnConnections = new Set<string>();
    
    meshConnections.forEach((connectedNodes, nodeHash) => {
      const fromCoords = nodeCoordinates.get(nodeHash);
      if (!fromCoords) return;
      
      connectedNodes.forEach(connectedHash => {
        // Create consistent key to avoid duplicate lines
        const connectionKey = [nodeHash, connectedHash].sort().join('-');
        if (drawnConnections.has(connectionKey)) return;
        drawnConnections.add(connectionKey);
        
        const toCoords = nodeCoordinates.get(connectedHash);
        if (!toCoords) return;
        
        lines.push({ from: fromCoords, to: toCoords, key: connectionKey });
      });
    });
    
    return lines;
  }, [meshConnections, nodeCoordinates]);
  
  // Collect all positions for bounds fitting
  const allPositions = useMemo(() => {
    const positions: [number, number][] = [];
    
    if (localNode && localNode.latitude && localNode.longitude) {
      positions.push([localNode.latitude, localNode.longitude]);
    }
    
    neighborsWithLocation.forEach(([, neighbor]) => {
      if (neighbor.latitude && neighbor.longitude) {
        positions.push([neighbor.latitude, neighbor.longitude]);
      }
    });
    
    return positions;
  }, [neighborsWithLocation, localNode]);
  
  // Default center (will be overridden by FitBounds)
  const defaultCenter: [number, number] = localNode && localNode.latitude && localNode.longitude
    ? [localNode.latitude, localNode.longitude]
    : allPositions.length > 0 
      ? allPositions[0] 
      : [51.505, -0.09]; // London as fallback
  
  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!mapContainerRef.current) return;
    
    if (!isFullscreen) {
      if (mapContainerRef.current.requestFullscreen) {
        mapContainerRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // No locations available
  if (allPositions.length === 0) {
    return (
      <div className="glass-card h-[500px] flex items-center justify-center">
        <div className="text-center text-white/50">
          <p className="text-lg mb-2">No Location Data Available</p>
          <p className="text-sm">
            Neighbors will appear on the map once they advertise their coordinates.
          </p>
        </div>
      </div>
    );
  }
  
  return (
    <div 
      ref={mapContainerRef}
      className="relative rounded-[1.125rem] overflow-hidden" 
      style={{ height: isFullscreen ? '100vh' : '500px' }}
    >
      {/* Map container with glass card styling */}
      <div className="glass-card h-full relative">
        {/* Glass overlay effect on top of map */}
        <div 
          className="absolute inset-0 z-[500] pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, rgba(140, 170, 220, 0.06) 0%, transparent 20%)',
            boxShadow: 'inset 4px 4px 7px -4px rgba(160, 180, 220, 0.12), inset -4px -4px 7px -4px rgba(100, 140, 180, 0.08)',
            borderRadius: 'inherit',
          }}
        />
        {/* Directional border overlay */}
        <div 
          className="absolute inset-0 z-[501] pointer-events-none"
          style={{
            borderRadius: 'inherit',
            border: '1px solid transparent',
            borderTopColor: 'rgba(140, 160, 200, 0.38)',
            borderLeftColor: 'rgba(140, 160, 200, 0.28)',
            borderRightColor: 'rgba(100, 140, 180, 0.15)',
            borderBottomColor: 'rgba(100, 140, 180, 0.18)',
          }}
        />
        <MapContainer
          center={defaultCenter}
          zoom={8}
          style={{ height: '100%', width: '100%', background: '#0d1520' }}
          attributionControl={true}
          className="map-blue-water"
        >
        {/* CARTO Dark Matter tiles with blue water tint applied via CSS */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          className="map-tiles-blue-tint"
        />
        
        <FitBoundsOnce positions={allPositions} />
        
        {/* Draw inferred mesh connections as dotted lines */}
        {meshPolylines.map(({ from, to, key }) => (
          <Polyline
            key={`mesh-${key}`}
            positions={[from, to]}
            color="rgba(255, 255, 255, 0.15)"
            weight={1.5}
            opacity={1}
            dashArray="4, 6"
          />
        ))}
        
        {/* Local node marker - matte plastic style with CSS shadows */}
        {localNode && localNode.latitude && localNode.longitude && (
          <Marker
            position={[localNode.latitude, localNode.longitude]}
            icon={createDotIcon(SIGNAL_COLORS.localNode, 24, hoveredMarker === 'local')}
            eventHandlers={{
              mouseover: () => setHoveredMarker('local'),
              mouseout: () => setHoveredMarker(null),
            }}
          >
            <Popup>
              <div className="text-gray-900 text-sm">
                <strong className="text-base">{localNode.name}</strong>
                <br />
                <span className="text-cyan-600 font-medium">This Node (Local)</span>
                <br />
                <span className="text-xs text-gray-500">
                  {localNode.latitude.toFixed(5)}, {localNode.longitude.toFixed(5)}
                </span>
              </div>
            </Popup>
          </Marker>
        )}
        
        {/* Neighbor markers - matte plastic style with CSS shadows */}
        {neighborsWithLocation.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Color all nodes by signal strength (mean SNR from packets, fallback to last SNR)
          const meanSnr = calculateMeanSnr(packets, hash);
          const displaySnr = meanSnr ?? neighbor.snr;
          const color = getSignalColor(displaySnr);
          
          const name = neighbor.node_name || neighbor.name || 'Unknown';
          const isHovered = hoveredMarker === hash;
          
          return (
            <Marker
              key={hash}
              position={[neighbor.latitude, neighbor.longitude]}
              icon={createDotIcon(color, 18, isHovered)}
              eventHandlers={{
                mouseover: () => setHoveredMarker(hash),
                mouseout: () => setHoveredMarker(null),
              }}
            >
              <Popup>
                <div className="text-gray-900 text-sm min-w-[150px]">
                  <strong className="text-base">{name}</strong>
                  <div className="mt-1">
                    <HashBadge hash={hash} size="sm" className="!bg-gray-100 !border-gray-200 !text-gray-700" />
                  </div>
                  <hr className="my-2 border-gray-200" />
                  {meanSnr !== undefined && (
                    <div>Mean SNR: <strong>{meanSnr.toFixed(1)} dB</strong></div>
                  )}
                  {neighbor.rssi !== undefined && (
                    <div>Last RSSI: <strong>{neighbor.rssi} dBm</strong></div>
                  )}
                  {neighbor.snr !== undefined && (
                    <div>Last SNR: <strong>{neighbor.snr.toFixed(1)} dB</strong></div>
                  )}
                  {neighbor.advert_count !== undefined && (
                    <div>Adverts: <strong>{neighbor.advert_count}</strong></div>
                  )}
                  <div className="text-xs text-gray-500 mt-1">
                    Last seen: {formatRelativeTime(neighbor.last_seen)}
                  </div>
                  <div className="text-xs text-gray-400">
                    {neighbor.latitude?.toFixed(5)}, {neighbor.longitude?.toFixed(5)}
                  </div>
                  {onRemoveNode && (
                    <button
                      onClick={() => onRemoveNode(hash)}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors border border-red-200"
                    >
                      <X className="w-3 h-3" />
                      Remove Node
                    </button>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
        </MapContainer>
        
        {/* Fullscreen button - top right, matching legend style */}
        <button
          onClick={toggleFullscreen}
          className="absolute top-4 right-4 z-[600] p-2 transition-colors hover:bg-white/10"
          style={{
            background: 'rgba(20, 20, 22, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
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
        
        {/* Legend - inside the map card, bottom-left corner */}
        <div 
          className="absolute bottom-4 left-4 z-[600] text-xs"
          style={{
            background: 'rgba(20, 20, 22, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderRadius: '0.75rem',
            padding: '0.625rem',
            border: '1px solid rgba(140, 160, 200, 0.2)',
            maxWidth: '100px',
          }}
        >
          <div className="text-text-secondary font-medium mb-1.5">Signal</div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.excellent, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">≥5 dB</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.good, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">0–5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.fair, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">-5–0</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.poor, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">-10–-5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.critical, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">&lt;-10</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/10">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.localNode, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Local</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
