import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { HashBadge } from '@/components/ui/HashBadge';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { buildMeshTopology, getEdgeWeight, getEdgeColor, TopologyEdge } from '@/lib/mesh-topology';

// Create a matte dot icon with CSS shadows
// Uses CSS transform for hover scaling to keep anchor point stable
function createDotIcon(color: string, size: number, isHovered: boolean = false): L.DivIcon {
  return L.divIcon({
    className: 'map-dot-marker',
    html: `<div style="
      width: ${size}px;
      height: ${size}px;
      background-color: ${color};
      border-radius: 50%;
      border: 0.75px solid rgba(13, 14, 18, 0.6);
      box-shadow: 0 2px 3px rgba(0, 0, 0, 0.08), inset 0 -2px 3px rgba(0, 0, 0, 0.06)${isHovered ? `, 0 0 12px ${color}` : ''};
      transition: transform 0.15s ease-out, box-shadow 0.15s ease-out, opacity 0.15s ease-out, filter 0.15s ease-out;
      transform: scale(${isHovered ? 1.25 : 1});
      opacity: ${isHovered ? 1 : 0.9};
      filter: brightness(${isHovered ? 1.1 : 1});
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
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
  localHash?: string;  // Local node's hash for zero-hop detection
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
  zeroHop: '#4338CA',    // Deep royal blue for zero-hop/direct neighbors
};

// Calculate mean SNR from packets for a given source hash
function calculateMeanSnr(packets: Packet[], srcHash: string): number | undefined {
  const nodePackets = packets.filter(p => p.src_hash === srcHash && p.snr !== undefined);
  if (nodePackets.length === 0) return undefined;
  
  const sum = nodePackets.reduce((acc, p) => acc + (p.snr ?? 0), 0);
  return sum / nodePackets.length;
}

/**
 * Analyze packets to determine which neighbors are zero-hop (direct RF contact).
 * 
 * A neighbor is considered zero-hop if we've received packets from them that:
 * 1. Have route_type = 1 (DIRECT) - meaning the packet wasn't relayed
 * 2. OR have an empty/short path where src_hash is the origin
 * 3. OR the last element of the path is the src_hash (they were last hop to us)
 * 
 * This is inferred from packet analysis similar to meshcoretomqtt's approach.
 */
function inferZeroHopNeighbors(packets: Packet[]): Set<string> {
  const zeroHopNodes = new Set<string>();
  
  for (const packet of packets) {
    // Skip if no source hash
    if (!packet.src_hash) continue;
    
    // Method 1: route_type = 1 (DIRECT) means zero-hop
    // route_type can be in 'route' or 'route_type' field
    const routeType = packet.route_type ?? packet.route;
    if (routeType === 1) {
      zeroHopNodes.add(packet.src_hash);
      continue;
    }
    
    // Method 2: Check path - if path is empty or src is at end, it's direct
    const path = packet.forwarded_path ?? packet.original_path;
    if (!path || path.length === 0) {
      // No path means we received directly from source
      zeroHopNodes.add(packet.src_hash);
      continue;
    }
    
    // Method 3: If the last element in the path matches src_hash,
    // it means that node was the last hop to reach us (zero-hop from us)
    if (path.length > 0) {
      const lastHop = path[path.length - 1];
      zeroHopNodes.add(lastHop);
    }
  }
  
  return zeroHopNodes;
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

export default function NeighborMap({ neighbors, localNode, localHash, packets = [], onRemoveNode }: NeighborMapProps) {
  // Track hover state per marker
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  
  // Confirmation modal state
  const [pendingRemove, setPendingRemove] = useState<{ hash: string; name: string } | null>(null);
  
  // Infer zero-hop neighbors from packet analysis
  const zeroHopNeighbors = useMemo(() => {
    return inferZeroHopNeighbors(packets);
  }, [packets]);
  
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
      // Store local node by 'local' key for legacy code
      coords.set('local', [localNode.latitude, localNode.longitude]);
      // Also store by actual hash for topology matching
      if (localHash) {
        coords.set(localHash, [localNode.latitude, localNode.longitude]);
      }
    }
    
    neighborsWithLocation.forEach(([hash, neighbor]) => {
      if (neighbor.latitude && neighbor.longitude) {
        coords.set(hash, [neighbor.latitude, neighbor.longitude]);
      }
    });
    
    return coords;
  }, [neighborsWithLocation, localNode, localHash]);
  
  // Build mesh topology with confidence-weighted edges (80% threshold)
  const meshTopology = useMemo(() => {
    return buildMeshTopology(packets, neighbors, localHash, 0.8);
  }, [packets, neighbors, localHash]);
  
  // Generate polylines for high-confidence topology connections
  const topologyPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      edge: TopologyEdge;
    }> = [];
    
    for (const edge of meshTopology.edges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      // Only draw if both nodes have coordinates
      if (!fromCoords || !toCoords) continue;
      
      lines.push({ from: fromCoords, to: toCoords, edge });
    }
    
    return lines;
  }, [meshTopology, nodeCoordinates]);
  
  // Legacy mesh connections for fallback (low-confidence dotted lines)
  const meshConnections = useMemo(() => {
    return inferMeshConnections(packets);
  }, [packets]);
  
  // Generate polylines for low-confidence mesh connections (not in topology)
  const fallbackPolylines = useMemo(() => {
    const lines: Array<{ from: [number, number]; to: [number, number]; key: string }> = [];
    const drawnConnections = new Set<string>();
    
    // Skip connections already in topology
    const topologyKeys = new Set(meshTopology.edges.map(e => e.key));
    
    meshConnections.forEach((connectedNodes, nodeHash) => {
      const fromCoords = nodeCoordinates.get(nodeHash);
      if (!fromCoords) return;
      
      connectedNodes.forEach(connectedHash => {
        const connectionKey = [nodeHash, connectedHash].sort().join('-');
        
        // Skip if already drawn or in high-confidence topology
        if (drawnConnections.has(connectionKey)) return;
        if (topologyKeys.has(connectionKey)) return;
        drawnConnections.add(connectionKey);
        
        const toCoords = nodeCoordinates.get(connectedHash);
        if (!toCoords) return;
        
        lines.push({ from: fromCoords, to: toCoords, key: connectionKey });
      });
    });
    
    return lines;
  }, [meshConnections, meshTopology, nodeCoordinates]);
  
  // Generate solid lines from local node to zero-hop neighbors
  const zeroHopLines = useMemo(() => {
    const lines: Array<{ from: [number, number]; to: [number, number]; key: string }> = [];
    
    if (!localNode || !localNode.latitude || !localNode.longitude) return lines;
    const localCoords: [number, number] = [localNode.latitude, localNode.longitude];
    
    // Draw lines from local node to each zero-hop neighbor with location
    neighborsWithLocation.forEach(([hash, neighbor]) => {
      if (zeroHopNeighbors.has(hash) && neighbor.latitude && neighbor.longitude) {
        lines.push({
          from: localCoords,
          to: [neighbor.latitude, neighbor.longitude],
          key: `zerohop-${hash}`,
        });
      }
    });
    
    return lines;
  }, [localNode, neighborsWithLocation, zeroHopNeighbors]);
  
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
        
        {/* Draw zero-hop direct connections as solid blue lines */}
        {zeroHopLines.map(({ from, to, key }) => (
          <Polyline
            key={key}
            positions={[from, to]}
            pathOptions={{
              color: SIGNAL_COLORS.zeroHop,
              weight: 2.5,
              opacity: 0.75,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        ))}
        
        {/* Draw high-confidence topology connections with strength-based styling */}
        {topologyPolylines.map(({ from, to, edge }) => {
          const weight = getEdgeWeight(edge.strength);
          const color = getEdgeColor(edge.strength);
          return (
            <Polyline
              key={`topology-${edge.key}`}
              positions={[from, to]}
              pathOptions={{
                color,
                weight,
                opacity: 0.85,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            >
              <Tooltip
                permanent={false}
                direction="center"
                className="topology-edge-tooltip"
              >
                <div className="text-xs">
                  <div className="font-medium">{edge.packetCount} packet{edge.packetCount !== 1 ? 's' : ''}</div>
                  <div className="text-text-muted">Confidence: {(edge.avgConfidence * 100).toFixed(0)}%</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
        {/* Draw low-confidence connections as faint dotted lines */}
        {fallbackPolylines.map(({ from, to, key }) => (
          <Polyline
            key={`mesh-${key}`}
            positions={[from, to]}
            pathOptions={{
              color: 'rgba(255, 255, 255, 0.12)',
              weight: 1,
              opacity: 1,
              dashArray: '3, 8',
              lineCap: 'round',
            }}
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
              <div className="text-sm">
                <strong className="text-base">{localNode.name}</strong>
                <br />
                <span className="text-accent-tertiary font-medium">This Node (Local)</span>
                <br />
                <span className="text-xs text-text-muted">
                  {localNode.latitude.toFixed(5)}, {localNode.longitude.toFixed(5)}
                </span>
              </div>
            </Popup>
          </Marker>
        )}
        
        {/* Neighbor markers - matte plastic style with CSS shadows */}
        {neighborsWithLocation.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Check if this is a zero-hop neighbor
          const isZeroHop = zeroHopNeighbors.has(hash);
          
          // Zero-hop neighbors get royal blue; others colored by signal strength
          const meanSnr = calculateMeanSnr(packets, hash);
          const displaySnr = meanSnr ?? neighbor.snr;
          const color = isZeroHop ? SIGNAL_COLORS.zeroHop : getSignalColor(displaySnr);
          
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
                <div className="text-sm min-w-[150px]">
                  <strong className="text-base">{name}</strong>
                  {isZeroHop && (
                    <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, color: '#fff' }}>DIRECT</span>
                  )}
                  <div className="mt-1">
                    <HashBadge hash={hash} size="sm" />
                  </div>
                  <hr className="my-2" />
                  {isZeroHop && (
                    <div className="text-text-secondary mb-1">Connection: <strong style={{ color: SIGNAL_COLORS.zeroHop }}>Zero-hop (Direct RF)</strong></div>
                  )}
                  {meanSnr !== undefined && (
                    <div className="text-text-secondary">Mean SNR: <strong className="text-text-primary">{meanSnr.toFixed(1)} dB</strong></div>
                  )}
                  {neighbor.rssi !== undefined && (
                    <div className="text-text-secondary">Last RSSI: <strong className="text-text-primary">{neighbor.rssi} dBm</strong></div>
                  )}
                  {neighbor.snr !== undefined && (
                    <div className="text-text-secondary">Last SNR: <strong className="text-text-primary">{neighbor.snr.toFixed(1)} dB</strong></div>
                  )}
                  {neighbor.advert_count !== undefined && (
                    <div className="text-text-secondary">Adverts: <strong className="text-text-primary">{neighbor.advert_count}</strong></div>
                  )}
                  <div className="text-xs text-text-muted mt-1">
                    Last seen: {formatRelativeTime(neighbor.last_seen)}
                  </div>
                  <div className="text-xs text-text-muted">
                    {neighbor.latitude?.toFixed(5)}, {neighbor.longitude?.toFixed(5)}
                  </div>
                  {onRemoveNode && (
                    <button
                      onClick={() => setPendingRemove({ hash, name })}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors border border-red-500/30"
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
        
        {/* Confirmation Modal */}
        <ConfirmModal
          isOpen={!!pendingRemove}
          title="Remove Node"
          message={`Are you sure you would like to remove ${pendingRemove?.name || 'this node'}?`}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={() => {
            if (pendingRemove && onRemoveNode) {
              onRemoveNode(pendingRemove.hash);
            }
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
        
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
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Direct</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.localNode, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Local</span>
            </div>
          </div>
          {/* Topology legend */}
          {topologyPolylines.length > 0 && (
            <>
              <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1.5">Links</div>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(74, 222, 128, 0.8)' }}></div>
                  <span className="text-text-muted">Strong</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(34, 211, 238, 0.6)' }}></div>
                  <span className="text-text-muted">Medium</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(255, 255, 255, 0.35)' }}></div>
                  <span className="text-text-muted">Weak</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
