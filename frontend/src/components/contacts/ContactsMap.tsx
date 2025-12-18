import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Maximize2, Minimize2, X, Network, Users, GitBranch, EyeOff, Info } from 'lucide-react';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { HashBadge } from '@/components/ui/HashBadge';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { buildMeshTopology, getLinkQualityColor, getLinkQualityWeight, TopologyEdge } from '@/lib/mesh-topology';

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

interface ContactsMapProps {
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

export default function ContactsMap({ neighbors, localNode, localHash, packets = [], onRemoveNode }: ContactsMapProps) {
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
  // Pass local coordinates for proximity-based scoring
  const meshTopology = useMemo(() => {
    return buildMeshTopology(
      packets, 
      neighbors, 
      localHash, 
      0.8,
      localNode?.latitude,
      localNode?.longitude
    );
  }, [packets, neighbors, localHash, localNode?.latitude, localNode?.longitude]);
  
  // Generate polylines for CERTAIN edges (100% validated connections)
  const certainPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      edge: TopologyEdge;
    }> = [];
    
    for (const edge of meshTopology.certainEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      // Only draw if both nodes have coordinates
      if (!fromCoords || !toCoords) continue;
      
      lines.push({ from: fromCoords, to: toCoords, edge });
    }
    
    return lines;
  }, [meshTopology, nodeCoordinates]);
  
  // Generate polylines for UNCERTAIN edges (inferred connections)
  const uncertainPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      edge: TopologyEdge;
    }> = [];
    
    for (const edge of meshTopology.uncertainEdges) {
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      // Only draw if both nodes have coordinates
      if (!fromCoords || !toCoords) continue;
      
      lines.push({ from: fromCoords, to: toCoords, edge });
    }
    
    return lines;
  }, [meshTopology, nodeCoordinates]);
  
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
  
  // Hub-only view toggle
  const [showHubsOnly, setShowHubsOnly] = useState(false);
  
  // Show/hide topology toggle
  const [showTopology, setShowTopology] = useState(true);
  
  // Show/hide hub markers toggle (independent of topology)
  const [showHubs, setShowHubs] = useState(true);
  
  // Build set of hub nodes and their connected neighbors for filtering
  const hubNodeSet = useMemo(() => new Set(meshTopology.hubNodes), [meshTopology.hubNodes]);
  
  // Get all nodes connected to hubs (for hub-only view)
  const hubConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    // Add local node (always show)
    if (localHash) connected.add(localHash);
    // Add hub nodes themselves
    for (const hub of meshTopology.hubNodes) {
      connected.add(hub);
    }
    // Add nodes connected to hubs via edges
    for (const edge of meshTopology.edges) {
      if (hubNodeSet.has(edge.fromHash) || hubNodeSet.has(edge.toHash)) {
        connected.add(edge.fromHash);
        connected.add(edge.toHash);
      }
    }
    return connected;
  }, [meshTopology, hubNodeSet, localHash]);
  
  // Filtered polylines based on hub-only mode
  const filteredCertainPolylines = useMemo(() => {
    if (!showHubsOnly) return certainPolylines;
    return certainPolylines.filter(({ edge }) => 
      hubNodeSet.has(edge.fromHash) || hubNodeSet.has(edge.toHash)
    );
  }, [certainPolylines, showHubsOnly, hubNodeSet]);
  
  const filteredUncertainPolylines = useMemo(() => {
    if (!showHubsOnly) return uncertainPolylines;
    return uncertainPolylines.filter(({ edge }) => 
      hubNodeSet.has(edge.fromHash) || hubNodeSet.has(edge.toHash)
    );
  }, [uncertainPolylines, showHubsOnly, hubNodeSet]);
  
  // Filtered neighbors based on hub-only mode
  const filteredNeighbors = useMemo(() => {
    if (!showHubsOnly) return neighborsWithLocation;
    return neighborsWithLocation.filter(([hash]) => hubConnectedNodes.has(hash));
  }, [neighborsWithLocation, showHubsOnly, hubConnectedNodes]);

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
        
        {/* Draw CERTAIN edges - SOLID if strong, DOTTED if weak */}
        {showTopology && filteredCertainPolylines.map(({ from, to, edge }) => {
          // Color based on link quality (green=strong, red=weak)
          const color = getLinkQualityColor(edge.certainCount, meshTopology.maxCertainCount);
          // Thickness based on validation frequency (thicker=stronger link)
          const weight = getLinkQualityWeight(edge.certainCount, meshTopology.maxCertainCount);
          
          // Calculate link quality percentage
          const linkQuality = meshTopology.maxCertainCount > 0 
            ? (edge.certainCount / meshTopology.maxCertainCount)
            : 0;
          
          // Weak links (< 30% quality) are dotted
          const isWeak = linkQuality < 0.3;
          
          // Get names for tooltip
          const fromNeighbor = neighbors[edge.fromHash];
          const toNeighbor = neighbors[edge.toHash];
          const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
          const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
          
          return (
            <Polyline
              key={`certain-${edge.key}`}
              positions={[from, to]}
              pathOptions={{
                color,
                weight,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
                dashArray: isWeak ? '4, 6' : undefined,
              }}
            >
              <Tooltip
                permanent={false}
                direction="center"
                className="topology-edge-tooltip"
              >
                <div className="text-xs">
                  <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
                  <div style={{ color }}>
                    Link quality: {Math.round(linkQuality * 100)}% ({edge.certainCount} validations)
                  </div>
                  <div className="text-text-muted">{edge.packetCount} total packet{edge.packetCount !== 1 ? 's' : ''}</div>
                  {edge.isHubConnection && (
                    <div className="text-amber-400">Hub connection</div>
                  )}
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
        {/* Draw UNCERTAIN/INFERRED edges as DOTTED GREY lines */}
        {showTopology && filteredUncertainPolylines.map(({ from, to, edge }) => {
          // Get names for tooltip
          const fromNeighbor = neighbors[edge.fromHash];
          const toNeighbor = neighbors[edge.toHash];
          const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
          const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
          
          return (
            <Polyline
              key={`uncertain-${edge.key}`}
              positions={[from, to]}
              pathOptions={{
                color: 'rgba(140, 140, 160, 0.6)', // Grey for inferred
                weight: 1.5,
                opacity: 1,
                dashArray: '4, 6',
                lineCap: 'round',
              }}
            >
              <Tooltip
                permanent={false}
                direction="center"
                className="topology-edge-tooltip"
              >
                <div className="text-xs">
                  <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
                  <div className="text-text-muted">Inferred ({(edge.avgConfidence * 100).toFixed(0)}% confidence)</div>
                  <div className="text-text-muted">{edge.packetCount} packet{edge.packetCount !== 1 ? 's' : ''}</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
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
        {filteredNeighbors.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Check if this is a zero-hop neighbor or hub node
          const isZeroHop = zeroHopNeighbors.has(hash);
          const isHub = meshTopology.hubNodes.includes(hash);
          const centrality = meshTopology.centrality.get(hash) || 0;
          
          // Skip hub nodes if hubs are hidden
          if (isHub && !showHubs) return null;
          
          // Hub nodes get amber, zero-hop gets blue, others by signal strength
          const meanSnr = calculateMeanSnr(packets, hash);
          const displaySnr = meanSnr ?? neighbor.snr;
          const color = (isHub && showHubs)
            ? '#FBBF24' // amber-400 for hub nodes
            : isZeroHop 
              ? SIGNAL_COLORS.zeroHop 
              : getSignalColor(displaySnr);
          
          // Hub nodes get larger markers
          const markerSize = (isHub && showHubs) ? 22 : 18;
          
          const name = neighbor.node_name || neighbor.name || 'Unknown';
          const isHovered = hoveredMarker === hash;
          
          // Get full affinity data for this neighbor
          const affinity = meshTopology.fullAffinity.get(hash);
          
          return (
            <Marker
              key={hash}
              position={[neighbor.latitude, neighbor.longitude]}
              icon={createDotIcon(color, markerSize, isHovered)}
              eventHandlers={{
                mouseover: () => setHoveredMarker(hash),
                mouseout: () => setHoveredMarker(null),
              }}
            >
              <Popup>
                <div className="text-sm min-w-[150px]">
                  <strong className="text-base">{name}</strong>
                  {isHub && (
                    <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded" style={{ backgroundColor: '#FBBF24', color: '#000' }}>HUB</span>
                  )}
                  {isZeroHop && !isHub && (
                    <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, color: '#fff' }}>DIRECT</span>
                  )}
                  {affinity && affinity.typicalHopPosition > 0 && !isZeroHop && !isHub && (
                    <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-surface-elevated text-text-secondary">{affinity.typicalHopPosition}-HOP</span>
                  )}
                  <div className="mt-1">
                    <HashBadge hash={hash} size="sm" />
                  </div>
                  <hr className="my-2" />
                  {isHub && centrality > 0 && (
                    <div className="text-text-secondary mb-1">Role: <strong style={{ color: '#FBBF24' }}>Network Hub ({(centrality * 100).toFixed(0)}% centrality)</strong></div>
                  )}
                  {isZeroHop && !isHub && (
                    <div className="text-text-secondary mb-1">Connection: <strong style={{ color: SIGNAL_COLORS.zeroHop }}>Zero-hop (Direct RF)</strong></div>
                  )}
                  {affinity && affinity.frequency > 1 && (
                    <div className="text-text-secondary">Packets seen: <strong className="text-text-primary">{affinity.frequency}</strong></div>
                  )}
                  {affinity && affinity.directForwardCount > 0 && (
                    <div className="text-text-secondary">Direct forwards: <strong className="text-accent-success">{affinity.directForwardCount}</strong></div>
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
        
        {/* Map controls - top right */}
        <div className="absolute top-4 right-4 z-[600] flex gap-2">
          {/* Show/hide topology toggle */}
          {(certainPolylines.length > 0 || uncertainPolylines.length > 0) && (
            <button
              onClick={() => setShowTopology(!showTopology)}
              className="p-2 transition-colors hover:bg-white/10"
              style={{
                background: showTopology ? 'rgba(74, 222, 128, 0.15)' : 'rgba(20, 20, 22, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: '0.75rem',
                border: showTopology ? '1px solid rgba(74, 222, 128, 0.4)' : '1px solid rgba(140, 160, 200, 0.2)',
              }}
              title={showTopology ? 'Hide topology lines' : 'Show topology lines'}
            >
              {showTopology ? (
                <GitBranch className="w-4 h-4 text-green-400" />
              ) : (
                <EyeOff className="w-4 h-4 text-text-secondary" />
              )}
            </button>
          )}
          
          {/* Hub markers toggle - independent of topology */}
          {meshTopology.hubNodes.length > 0 && (
            <button
              onClick={() => setShowHubs(!showHubs)}
              className="p-2 transition-colors hover:bg-white/10"
              style={{
                background: showHubs ? 'rgba(251, 191, 36, 0.2)' : 'rgba(20, 20, 22, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: '0.75rem',
                border: showHubs ? '1px solid rgba(251, 191, 36, 0.5)' : '1px solid rgba(140, 160, 200, 0.2)',
              }}
              title={showHubs ? 'Hide hub highlighting' : 'Show hub highlighting'}
            >
              <Network className={`w-4 h-4 ${showHubs ? 'text-amber-400' : 'text-text-secondary'}`} />
            </button>
          )}
          
          {/* Hub-only filter toggle - only show if there are hubs */}
          {meshTopology.hubNodes.length > 0 && (
            <button
              onClick={() => setShowHubsOnly(!showHubsOnly)}
              className="p-2 transition-colors hover:bg-white/10"
              style={{
                background: showHubsOnly ? 'rgba(139, 92, 246, 0.2)' : 'rgba(20, 20, 22, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: '0.75rem',
                border: showHubsOnly ? '1px solid rgba(139, 92, 246, 0.5)' : '1px solid rgba(140, 160, 200, 0.2)',
              }}
              title={showHubsOnly ? 'Show all nodes' : 'Filter to hub connections only'}
            >
              <Users className={`w-4 h-4 ${showHubsOnly ? 'text-violet-400' : 'text-text-secondary'}`} />
            </button>
          )}
          
          {/* Fullscreen button */}
          <button
            onClick={toggleFullscreen}
            className="p-2 transition-colors hover:bg-white/10"
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
        </div>
        
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
            maxWidth: '140px',
          }}
        >
          <div className="text-text-secondary font-medium mb-1.5 flex items-center gap-1">
            Signal (SNR)
            <span className="group relative cursor-help">
              <Info className="w-3 h-3 text-text-muted" />
              <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-48 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                Node color indicates mean SNR from received packets. Higher SNR = better signal quality.
              </div>
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.excellent, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Excellent ≥5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.good, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Good 0–5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.fair, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Fair -5–0</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.poor, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Poor -10–-5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.critical, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Critical &lt;-10</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/10">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Direct (0-hop)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.localNode, border: '0.75px solid rgba(13,14,18,0.6)', boxShadow: '0 2px 3px rgba(0,0,0,0.08), inset 0 -2px 3px rgba(0,0,0,0.06)' }}></div>
              <span className="text-text-muted">Local node</span>
            </div>
          </div>
          {/* Topology legend - link quality based (only show when topology visible) */}
          {showTopology && (certainPolylines.length > 0 || uncertainPolylines.length > 0) && (
            <>
              <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1.5 flex items-center gap-1">
                Links
                <span className="group relative cursor-help">
                  <Info className="w-3 h-3 text-text-muted" />
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-48 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                    <strong>Verified:</strong> Both endpoints identified in packet paths. Color/thickness = link frequency.<br/><br/>
                    <strong>Inferred:</strong> One or both endpoints ambiguous (prefix matched multiple nodes).
                  </div>
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {/* Link quality gradient for verified edges */}
                <div className="flex items-center gap-1.5 group relative">
                  <div className="w-4 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(74, 222, 128, 0.9)' }}></div>
                  <span className="text-text-muted">Strong</span>
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-40 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                    ≥70% of max validation count. Thick solid line.
                  </div>
                </div>
                <div className="flex items-center gap-1.5 group relative">
                  <div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(250, 204, 21, 0.7)' }}></div>
                  <span className="text-text-muted">Moderate</span>
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-40 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                    30-70% of max validation count. Medium solid line.
                  </div>
                </div>
                <div className="flex items-center gap-1.5 group relative">
                  <div className="w-4 h-0.5 flex-shrink-0" style={{ 
                    background: 'repeating-linear-gradient(90deg, rgba(248, 113, 113, 0.6) 0px, rgba(248, 113, 113, 0.6) 2px, transparent 2px, transparent 4px)'
                  }}></div>
                  <span className="text-text-muted">Weak</span>
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-40 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                    &lt;30% of max validation count. Thin dotted line.
                  </div>
                </div>
                {/* Inferred edges - dotted grey lines */}
                <div className="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/10 group relative">
                  <div className="w-4 h-0.5 flex-shrink-0" style={{ 
                    background: 'repeating-linear-gradient(90deg, rgba(140, 140, 160, 0.6) 0px, rgba(140, 140, 160, 0.6) 2px, transparent 2px, transparent 4px)'
                  }}></div>
                  <span className="text-text-muted">Inferred</span>
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                    Connection inferred from path data but one/both nodes ambiguous (multiple prefix matches).
                  </div>
                </div>
                {meshTopology.hubNodes.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/10 group relative">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgba(251, 191, 36, 0.85)' }}></div>
                    <span className="text-text-muted">Hub node</span>
                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight bg-surface-elevated border border-border-subtle rounded-lg shadow-lg z-10">
                      High betweenness centrality (≥50%) AND appears in ≥5% of packet paths. Key routing node.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
