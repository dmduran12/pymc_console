import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Maximize2, Minimize2, X, Network, Radio, GitBranch, EyeOff, Info, Copy, Check } from 'lucide-react';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { buildMeshTopology, getLinkQualityColor, getLinkQualityWeight, TopologyEdge } from '@/lib/mesh-topology';

// Uniform marker size for all nodes
const MARKER_SIZE = 16;

// Create a matte dot icon with CSS shadows
// Uses CSS transform for hover scaling to keep anchor point stable
function createDotIcon(color: string, isHovered: boolean = false): L.DivIcon {
  return L.divIcon({
    className: 'map-dot-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background-color: ${color};
      border-radius: 50%;
      border: 1px solid rgba(13, 14, 18, 0.8);
      box-shadow: 0 2px 3px rgba(0, 0, 0, 0.15), inset 0 -2px 3px rgba(0, 0, 0, 0.1)${isHovered ? `, 0 0 12px ${color}` : ''};
      transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
      transform: scale(${isHovered ? 1.3 : 1});
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
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

// Glass-style tooltip for legend items
function LegendTooltip({ text }: { text: string }) {
  return (
    <span className="group relative cursor-help">
      <Info className="w-3 h-3 text-text-muted" />
      <div 
        className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight rounded-lg shadow-lg z-10"
        style={{
          background: 'rgba(20, 20, 22, 0.95)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(140, 160, 200, 0.25)',
        }}
      >
        {text}
      </div>
    </span>
  );
}

// Legend item with hover tooltip
function LegendItem({ indicator, label, tooltip }: { indicator: React.ReactNode; label: string; tooltip: string }) {
  return (
    <div className="flex items-center gap-1.5 group relative">
      {indicator}
      <span className="text-text-muted">{label}</span>
      <div 
        className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-40 p-2 text-[10px] leading-tight rounded-lg shadow-lg z-10"
        style={{
          background: 'rgba(20, 20, 22, 0.95)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(140, 160, 200, 0.25)',
        }}
      >
        {tooltip}
      </div>
    </div>
  );
}

// Compact node popup content
interface NodePopupContentProps {
  hash: string;
  hashPrefix: string;
  name: string;
  isHub: boolean;
  isZeroHop: boolean;
  centrality: number;
  affinity?: { frequency: number; directForwardCount: number; typicalHopPosition: number };
  meanSnr?: number;
  neighbor: NeighborInfo;
  onRemove?: () => void;
}

function NodePopupContent({ hash, hashPrefix, name, isHub, isZeroHop, centrality, affinity, meanSnr, neighbor, onRemove }: NodePopupContentProps) {
  const [copied, setCopied] = useState(false);
  
  const copyHash = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  
  return (
    <div className="text-sm min-w-[160px]">
      {/* Header row: Name + pills */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <strong className="text-base leading-tight">{name}</strong>
          {isHub && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full" style={{ backgroundColor: '#FBBF24', color: '#000' }}>HUB</span>
          )}
          {isZeroHop && !isHub && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, color: '#fff' }}>DIRECT</span>
          )}
          {affinity && affinity.typicalHopPosition > 0 && !isZeroHop && !isHub && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-surface-elevated text-text-secondary">{affinity.typicalHopPosition}-HOP</span>
          )}
        </div>
      </div>
      
      {/* Hash row: 2-char prefix + copy button */}
      <div className="flex items-center gap-1.5 mt-1">
        <span className="font-mono text-xs text-text-muted bg-surface-elevated px-1.5 py-0.5 rounded">{hashPrefix}</span>
        <button
          onClick={copyHash}
          className="p-1 hover:bg-surface-elevated rounded transition-colors"
          title="Copy full hash"
        >
          {copied ? <Check className="w-3 h-3 text-accent-success" /> : <Copy className="w-3 h-3 text-text-muted" />}
        </button>
        {/* Compact stats in header */}
        {affinity && affinity.frequency > 0 && (
          <span className="text-[10px] text-text-muted">{affinity.frequency} pkts</span>
        )}
        {neighbor.advert_count !== undefined && neighbor.advert_count > 0 && (
          <span className="text-[10px] text-text-muted">{neighbor.advert_count} advs</span>
        )}
      </div>
      
      <hr className="my-2 border-white/10" />
      
      {/* Role info */}
      {isHub && centrality > 0 && (
        <div className="text-text-secondary text-xs mb-1">
          <strong style={{ color: '#FBBF24' }}>Hub ({(centrality * 100).toFixed(0)}% centrality)</strong>
        </div>
      )}
      
      {/* Signal info */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        {meanSnr !== undefined && (
          <div className="text-text-secondary">SNR: <strong className="text-text-primary">{meanSnr.toFixed(1)}</strong></div>
        )}
        {neighbor.rssi !== undefined && (
          <div className="text-text-secondary">RSSI: <strong className="text-text-primary">{neighbor.rssi}</strong></div>
        )}
      </div>
      
      {/* Last seen */}
      <div className="text-[10px] text-text-muted mt-1">
        {formatRelativeTime(neighbor.last_seen)}
      </div>
      
      {/* Remove button */}
      {onRemove && (
        <button
          onClick={onRemove}
          className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors border border-red-500/30"
        >
          <X className="w-3 h-3" />
          Remove
        </button>
      )}
    </div>
  );
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
  
  // Generate polylines for validated edges (3+ validations)
  const validatedPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      edge: TopologyEdge;
    }> = [];
    
    for (const edge of meshTopology.validatedEdges) {
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
  
  // Solo modes - filter to show only specific node types
  const [soloHubs, setSoloHubs] = useState(false);
  const [soloDirect, setSoloDirect] = useState(false);
  
  // Show/hide topology toggle
  const [showTopology, setShowTopology] = useState(true);
  
  // Build set of hub nodes and zero-hop nodes for filtering
  const hubNodeSet = useMemo(() => new Set(meshTopology.hubNodes), [meshTopology.hubNodes]);
  
  // Get all nodes connected to hubs (for solo hubs mode)
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
  
  // Direct (zero-hop) nodes set
  const directNodeSet = useMemo(() => {
    const direct = new Set<string>();
    if (localHash) direct.add(localHash);
    for (const hash of zeroHopNeighbors) {
      direct.add(hash);
    }
    return direct;
  }, [zeroHopNeighbors, localHash]);
  
  // Filtered polylines based on solo modes
  const filteredCertainPolylines = useMemo(() => {
    if (!soloHubs && !soloDirect) return validatedPolylines;
    return validatedPolylines.filter(({ edge }) => {
      const fromHub = hubNodeSet.has(edge.fromHash);
      const toHub = hubNodeSet.has(edge.toHash);
      const fromDirect = directNodeSet.has(edge.fromHash);
      const toDirect = directNodeSet.has(edge.toHash);
      
      if (soloHubs && soloDirect) {
        // Show hub connections OR direct connections
        return fromHub || toHub || fromDirect || toDirect;
      } else if (soloHubs) {
        return fromHub || toHub;
      } else if (soloDirect) {
        return fromDirect || toDirect;
      }
      return true;
    });
  }, [validatedPolylines, soloHubs, soloDirect, hubNodeSet, directNodeSet]);
  
  // Filtered neighbors based on solo modes
  const filteredNeighbors = useMemo(() => {
    if (!soloHubs && !soloDirect) return neighborsWithLocation;
    return neighborsWithLocation.filter(([hash]) => {
      const isHubConnected = hubConnectedNodes.has(hash);
      const isDirect = directNodeSet.has(hash);
      
      if (soloHubs && soloDirect) {
        return isHubConnected || isDirect;
      } else if (soloHubs) {
        return isHubConnected;
      } else if (soloDirect) {
        return isDirect;
      }
      return true;
    });
  }, [neighborsWithLocation, soloHubs, soloDirect, hubConnectedNodes, directNodeSet]);

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
        
        {/* Draw validated topology edges - solid lines, color by link quality */}
        {showTopology && filteredCertainPolylines.map(({ from, to, edge }) => {
          // Color based on link quality (green=strong, red=weak)
          const color = getLinkQualityColor(edge.certainCount, meshTopology.maxCertainCount);
          // Thickness based on validation frequency (thicker=stronger link)
          const weight = getLinkQualityWeight(edge.certainCount, meshTopology.maxCertainCount);
          
          // Calculate link quality percentage
          const linkQuality = meshTopology.maxCertainCount > 0 
            ? (edge.certainCount / meshTopology.maxCertainCount)
            : 0;
          
          // Get names for tooltip
          const fromNeighbor = neighbors[edge.fromHash];
          const toNeighbor = neighbors[edge.toHash];
          const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
          const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
          
          return (
            <Polyline
              key={`edge-${edge.key}`}
              positions={[from, to]}
              pathOptions={{
                color,
                weight,
                opacity: 1,
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
                  <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
                  <div style={{ color }}>
                    {Math.round(linkQuality * 100)}% ({edge.certainCount} validations)
                  </div>
                  {edge.isHubConnection && (
                    <div className="text-amber-400">Hub connection</div>
                  )}
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
        {/* Note: Uncertain edges are no longer rendered - only validated (3+) topology shown */}
        
        {/* Local node marker - matte plastic style with CSS shadows */}
        {localNode && localNode.latitude && localNode.longitude && (
          <Marker
            position={[localNode.latitude, localNode.longitude]}
            icon={createDotIcon(SIGNAL_COLORS.localNode, hoveredMarker === 'local')}
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
        
        {/* Neighbor markers - uniform size, color by type */}
        {filteredNeighbors.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Check if this is a zero-hop neighbor or hub node
          const isZeroHop = zeroHopNeighbors.has(hash);
          const isHub = meshTopology.hubNodes.includes(hash);
          const centrality = meshTopology.centrality.get(hash) || 0;
          
          // Hub nodes get amber, zero-hop gets the SIGNAL_COLORS.zeroHop (deep blue), others by signal
          const meanSnr = calculateMeanSnr(packets, hash);
          const displaySnr = meanSnr ?? neighbor.snr;
          const color = isHub
            ? '#FBBF24' // amber-400 for hub nodes
            : isZeroHop 
              ? SIGNAL_COLORS.zeroHop // Deep royal blue for direct
              : getSignalColor(displaySnr);
          
          const name = neighbor.node_name || neighbor.name || 'Unknown';
          const isHovered = hoveredMarker === hash;
          
          // Get full affinity data for this neighbor
          const affinity = meshTopology.fullAffinity.get(hash);
          
          // Compact hash prefix (2 chars)
          const hashPrefix = hash.startsWith('0x') ? hash.slice(2, 4).toUpperCase() : hash.slice(0, 2).toUpperCase();
          
          return (
            <Marker
              key={hash}
              position={[neighbor.latitude, neighbor.longitude]}
              icon={createDotIcon(color, isHovered)}
              eventHandlers={{
                mouseover: () => setHoveredMarker(hash),
                mouseout: () => setHoveredMarker(null),
              }}
            >
              <Popup>
                <NodePopupContent
                  hash={hash}
                  hashPrefix={hashPrefix}
                  name={name}
                  isHub={isHub}
                  isZeroHop={isZeroHop}
                  centrality={centrality}
                  affinity={affinity}
                  meanSnr={meanSnr}
                  neighbor={neighbor}
                  onRemove={onRemoveNode ? () => setPendingRemove({ hash, name }) : undefined}
                />
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
          {validatedPolylines.length > 0 && (
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
          
          {/* Solo Hubs toggle */}
          {meshTopology.hubNodes.length > 0 && (
            <button
              onClick={() => setSoloHubs(!soloHubs)}
              className="p-2 transition-colors hover:bg-white/10"
              style={{
                background: soloHubs ? 'rgba(251, 191, 36, 0.2)' : 'rgba(20, 20, 22, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: '0.75rem',
                border: soloHubs ? '1px solid rgba(251, 191, 36, 0.5)' : '1px solid rgba(140, 160, 200, 0.2)',
              }}
              title={soloHubs ? 'Show all nodes' : 'Solo hubs & connections'}
            >
              <Network className={`w-4 h-4 ${soloHubs ? 'text-amber-400' : 'text-text-secondary'}`} />
            </button>
          )}
          
          {/* Solo Direct toggle */}
          {zeroHopNeighbors.size > 0 && (
            <button
              onClick={() => setSoloDirect(!soloDirect)}
              className="p-2 transition-colors hover:bg-white/10"
              style={{
                background: soloDirect ? 'rgba(67, 56, 202, 0.3)' : 'rgba(20, 20, 22, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: '0.75rem',
                border: soloDirect ? '1px solid rgba(67, 56, 202, 0.6)' : '1px solid rgba(140, 160, 200, 0.2)',
              }}
              title={soloDirect ? 'Show all nodes' : 'Solo direct (0-hop) nodes'}
            >
              <Radio className={`w-4 h-4 ${soloDirect ? 'text-indigo-400' : 'text-text-secondary'}`} />
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
            <LegendTooltip text="Node color indicates mean SNR from received packets. Higher SNR = better signal quality." />
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.excellent, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Excellent ≥5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.good, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Good 0–5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.fair, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Fair -5–0</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.poor, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Poor -10–-5</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.critical, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Critical &lt;-10</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/10">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.zeroHop, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Direct (0-hop)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SIGNAL_COLORS.localNode, border: '1px solid rgba(13,14,18,0.8)' }}></div>
              <span className="text-text-muted">Local node</span>
            </div>
          </div>
          {/* Topology legend - link quality based (only show when topology visible) */}
          {showTopology && validatedPolylines.length > 0 && (
            <>
              <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1.5 flex items-center gap-1">
                Links (3+ validations)
                <LegendTooltip text="Only showing connections validated 3+ times. Line thickness = validation count." />
              </div>
              <div className="flex flex-col gap-0.5">
                <LegendItem 
                  indicator={<div className="w-4 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgb(74, 222, 128)' }} />}
                  label="Strong"
                  tooltip="≥70% of max validation count. Thick solid line."
                />
                <LegendItem 
                  indicator={<div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgb(250, 204, 21)' }} />}
                  label="Moderate"
                  tooltip="30-70% of max validation count. Medium line."
                />
                <LegendItem 
                  indicator={<div className="w-4 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgb(248, 113, 113)' }} />}
                  label="Weak"
                  tooltip="<30% of max validation count. Thin line."
                />
                {meshTopology.hubNodes.length > 0 && (
                  <div className="mt-1 pt-1 border-t border-white/10">
                    <LegendItem 
                      indicator={<div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'rgb(251, 191, 36)', border: '1px solid rgba(13,14,18,0.8)' }} />}
                      label="Hub node"
                      tooltip="High betweenness centrality (≥50%) AND appears in ≥1% of packet paths."
                    />
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
