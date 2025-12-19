import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Maximize2, Minimize2, X, Network, Radio, GitBranch, EyeOff, Info, Copy, Check, RefreshCw } from 'lucide-react';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { getLinkQualityWeight, type TopologyEdge } from '@/lib/mesh-topology';
import { useTopology } from '@/lib/stores/useTopologyStore';
import { usePackets } from '@/lib/stores/useStore';
import { parsePath, getHashPrefix } from '@/lib/path-utils';

// ═══════════════════════════════════════════════════════════════════════════════
// Design System Constants
// ═══════════════════════════════════════════════════════════════════════════════

// Uniform marker size for all nodes (outer dimension)
const MARKER_SIZE = 14;
// Ring thickness - thick enough for small donut hole
const RING_THICKNESS = 5;

// Design palette - sophisticated, minimal, low contrast against dark map
const DESIGN = {
  // Primary node color - deep royal blue-purple, dark and subtle
  nodeColor: '#4338CA',        // Deep indigo/royal blue
  // Local node - slightly brighter but still muted
  localColor: '#4F46E5',       // Indigo-600
  // Edge colors - solid colors for crisp rendering (no alpha to avoid overlap artifacts)
  edgeColor: '#3B3F4A',        // Dark gray - solid, no transparency
  loopEdgeColor: '#3730A3',    // Indigo-800 darkened (70% black mix)
  // Hub indicator - 25% brighter, saturated royal blue-purple
  hubColor: '#6366F1',         // Indigo-500 (brighter, still saturated)
};

/**
 * Create a ring (torus) icon for standard nodes.
 * Thick ring with small donut hole - no stroke, just the ring itself.
 */
function createRingIcon(color: string = DESIGN.nodeColor): L.DivIcon {
  return L.divIcon({
    className: 'map-ring-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background: transparent;
      border-radius: 50%;
      border: ${RING_THICKNESS}px solid ${color};
      box-sizing: border-box;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
  });
}

/**
 * Create a filled dot icon for hub nodes.
 * Same outer dimension as ring - no border/stroke.
 */
function createFilledIcon(color: string = DESIGN.hubColor): L.DivIcon {
  return L.divIcon({
    className: 'map-filled-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background-color: ${color};
      border-radius: 50%;
      box-sizing: border-box;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
  });
}

/**
 * Create local node icon - filled, same size as other nodes, no stroke.
 */
function createLocalIcon(): L.DivIcon {
  return L.divIcon({
    className: 'map-local-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background-color: ${DESIGN.localColor};
      border-radius: 50%;
      box-sizing: border-box;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
  });
}

/**
 * Calculate offset positions for parallel (double) lines.
 * Used for loop edges to visually indicate redundancy.
 */
function getParallelOffsets(
  from: [number, number],
  to: [number, number],
  offset: number
): { line1: [[number, number], [number, number]]; line2: [[number, number], [number, number]] } {
  // Calculate perpendicular offset
  const dx = to[1] - from[1]; // longitude diff
  const dy = to[0] - from[0]; // latitude diff
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len === 0) {
    return {
      line1: [from, to],
      line2: [from, to],
    };
  }
  
  // Perpendicular unit vector (normalized)
  const perpX = -dy / len;
  const perpY = dx / len;
  
  // Scale offset (convert degrees to approximate visual offset)
  const scale = offset * 0.00002; // Adjust for reasonable visual separation
  
  const offsetX = perpX * scale;
  const offsetY = perpY * scale;
  
  return {
    line1: [
      [from[0] + offsetX, from[1] + offsetY],
      [to[0] + offsetX, to[1] + offsetY],
    ],
    line2: [
      [from[0] - offsetX, from[1] - offsetY],
      [to[0] - offsetX, to[1] - offsetY],
    ],
  };
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
  onRemoveNode?: (hash: string) => void;
}

// Legacy signal colors (kept for popup display)
const SIGNAL_COLORS = {
  excellent: '#4CFFB5',
  good: '#39D98A',
  fair: '#F9D26F',
  poor: '#FF8A5C',
  critical: '#FF5C7A',
  unknown: '#767688',
  localNode: DESIGN.localColor,
  zeroHop: DESIGN.nodeColor,
};

/**
 * Calculate mean SNR from packets for a given source hash.
 * 
 * IMPORTANT: The SNR value in a packet is what the LOCAL NODE measured when receiving.
 * For multi-hop packets, this SNR reflects the LAST HOP quality (neighbor → local),
 * NOT the RF link quality to the original source.
 * 
 * This function returns the mean SNR for display purposes, but consumers should
 * understand this is only meaningful for direct (zero-hop) neighbors.
 */
function calculateMeanSnr(packets: Packet[], srcHash: string): number | undefined {
  const nodePackets = packets.filter(p => p.src_hash === srcHash && p.snr !== undefined);
  if (nodePackets.length === 0) return undefined;
  
  const sum = nodePackets.reduce((acc, p) => acc + (p.snr ?? 0), 0);
  return sum / nodePackets.length;
}

/**
 * Analyze packets and topology to determine which neighbors are zero-hop (direct RF contact with local).
 * 
 * A neighbor is considered zero-hop if we've DIRECTLY received RF signal from them.
 * This is determined by:
 * 1. Topology edges with hopDistanceFromLocal === 0 (most reliable - uses disambiguation)
 * 2. route_type = 1 (DIRECT) AND src_hash matches - they sent directly to us
 * 3. Empty path AND src_hash matches - no forwarding, direct reception
 * 4. Last hop prefix matches their hash prefix (fallback when no topology available)
 * 
 * IMPORTANT: The topology approach (method 1) is preferred because it uses the centralized
 * prefix disambiguation system which considers position consistency, co-occurrence patterns,
 * and geographic proximity to resolve prefix collisions.
 * 
 * @param packets - All received packets
 * @param neighbors - Known neighbors (to match prefixes to full hashes)
 * @param topologyEdges - Optional validated edges from topology (preferred for disambiguation)
 * @param localHash - Local node hash (for matching topology edges)
 */
function inferZeroHopNeighbors(
  packets: Packet[], 
  neighbors: Record<string, NeighborInfo>,
  topologyEdges?: { fromHash: string; toHash: string; hopDistanceFromLocal: number }[],
  localHash?: string
): Set<string> {
  const zeroHopNodes = new Set<string>();
  
  // Method 1: Use topology edges with hopDistanceFromLocal === 0
  // This is the most reliable method because it uses the disambiguation system
  if (topologyEdges && localHash) {
    for (const edge of topologyEdges) {
      if (edge.hopDistanceFromLocal === 0) {
        // This edge connects directly to local
        if (edge.fromHash === localHash && edge.toHash !== localHash) {
          zeroHopNodes.add(edge.toHash);
        } else if (edge.toHash === localHash && edge.fromHash !== localHash) {
          zeroHopNodes.add(edge.fromHash);
        }
      }
    }
  }
  
  // Build prefix -> full hash lookup for fallback prefix matching
  const prefixToHash = new Map<string, string[]>();
  for (const hash of Object.keys(neighbors)) {
    const prefix = getHashPrefix(hash);
    const existing = prefixToHash.get(prefix) || [];
    existing.push(hash);
    prefixToHash.set(prefix, existing);
  }
  
  for (const packet of packets) {
    // Skip if no source hash
    if (!packet.src_hash) continue;
    
    // Method 2: route_type = 1 (DIRECT) means the source sent directly to us
    const routeType = packet.route_type ?? packet.route;
    if (routeType === 1) {
      zeroHopNodes.add(packet.src_hash);
      continue;
    }
    
    // Method 3: Empty path means we received directly from source (no relays)
    const path = packet.forwarded_path ?? packet.original_path;
    if (!path || path.length === 0) {
      zeroHopNodes.add(packet.src_hash);
      continue;
    }
    
    // Method 4: (Fallback) The LAST non-local element in the path is the node that transmitted to us.
    // Only use this if we don't already have edges from topology
    // Note: This is less reliable for prefix collisions
    // Use centralized path parsing which handles local stripping
    if (path.length > 0 && (!topologyEdges || topologyEdges.length === 0)) {
      const parsed = parsePath(path, localHash);
      if (!parsed || parsed.effectiveLength === 0) continue;
      
      // Last element in effective path is the last forwarder (transmitted to us)
      const lastHopPrefix = parsed.effective[parsed.effectiveLength - 1];
      
      // Find neighbors matching this prefix
      const matchingHashes = prefixToHash.get(lastHopPrefix) || [];
      
      if (matchingHashes.length === 1) {
        // Unique match - we know exactly which neighbor forwarded to us
        zeroHopNodes.add(matchingHashes[0]);
      } else if (matchingHashes.length > 1) {
        // Multiple neighbors share this prefix - add all as candidates
        for (const hash of matchingHashes) {
          zeroHopNodes.add(hash);
        }
      }
    }
  }
  
  return zeroHopNodes;
}

// Simple tooltip for legend items - no blur for performance
function LegendTooltip({ text }: { text: string }) {
  return (
    <span className="group relative cursor-help">
      <Info className="w-3 h-3 text-text-muted" />
      <div 
        className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 text-[10px] leading-tight rounded-lg z-10"
        style={{
          background: 'rgba(20, 20, 22, 0.98)',
          border: '1px solid rgba(140, 160, 200, 0.3)',
        }}
      >
        {text}
      </div>
    </span>
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
      
      {/* Signal info - only meaningful for direct neighbors */}
      {isZeroHop && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          {meanSnr !== undefined && (
            <div className="text-text-secondary">SNR: <strong className="text-text-primary">{meanSnr.toFixed(1)}</strong></div>
          )}
          {neighbor.rssi !== undefined && (
            <div className="text-text-secondary">RSSI: <strong className="text-text-primary">{neighbor.rssi}</strong></div>
          )}
        </div>
      )}
      {!isZeroHop && (meanSnr !== undefined || neighbor.rssi !== undefined) && (
        <div className="text-[10px] text-text-muted italic">
          Signal metrics shown are from relay, not direct RF
        </div>
      )}
      
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
        map.setView(positions[0], 14);
      } else {
        // Minimal padding for tighter framing of the mesh
        map.fitBounds(positions, { 
          padding: [15, 15],
          maxZoom: 16
        });
      }
    }
  }, [map, positions]);
  
  return null;
}

export default function ContactsMap({ neighbors, localNode, localHash, onRemoveNode }: ContactsMapProps) {
  // Track hover state per marker (setHoveredMarker used for events, hoveredMarker reserved for future use)
  const [, setHoveredMarker] = useState<string | null>(null);
  
  // Confirmation modal state
  const [pendingRemove, setPendingRemove] = useState<{ hash: string; name: string } | null>(null);
  
  // Get topology from store (computed by worker)
  const meshTopology = useTopology();
  
  // Get packets for SNR calculation (lightweight, still needed)
  const packets = usePackets();
  
  // Infer zero-hop neighbors from packet analysis AND topology edges
  // Topology edges use the disambiguation system for more accurate prefix resolution
  const zeroHopNeighbors = useMemo(() => {
    return inferZeroHopNeighbors(
      packets, 
      neighbors, 
      meshTopology.validatedEdges,  // Use disambiguated edges
      localHash
    );
  }, [packets, neighbors, meshTopology.validatedEdges, localHash]);
  
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
  
  // Generate polylines for validated edges (from topology store)
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
  
  // Show/hide topology toggle (default OFF for cleaner initial view)
  const [showTopology, setShowTopology] = useState(false);
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // Edge Animation System (state declarations - effect is after filteredCertainPolylines)
  // - "Trace" effect: lines draw from point A to B
  // - Thickness growth: existing edges animate to new weight when data changes
  // ═══════════════════════════════════════════════════════════════════════════════
  
  const ANIMATION_DURATION = 2000; // 2 seconds
  
  // Track animation progress per edge (0 = not started, 1 = complete)
  const [edgeAnimProgress, setEdgeAnimProgress] = useState<Map<string, number>>(new Map());
  
  // Track previous weights for thickness animation
  const prevWeightsRef = useRef<Map<string, number>>(new Map());
  const [weightAnimProgress, setWeightAnimProgress] = useState(1); // 0-1 for weight interpolation
  
  // Track which edges we've seen before (for detecting new edges)
  const knownEdgesRef = useRef<Set<string>>(new Set());
  
  // Track the last edge set to detect changes (for "pull more data" scenario)
  const lastEdgeSetRef = useRef<string>('');
  
  // Track if we're in the middle of initial animation (to prevent flash)
  const [isAnimatingInitial, setIsAnimatingInitial] = useState(false);
  
  // Cubic ease-in-out helper
  const easeInOutCubic = (t: number): number => {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  
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
  
  // Direct (zero-hop) nodes set - ONLY local and its immediate zero-hop neighbors
  const directNodeSet = useMemo(() => {
    const direct = new Set<string>();
    if (localHash) direct.add(localHash);
    for (const hash of zeroHopNeighbors) {
      direct.add(hash);
    }
    return direct;
  }, [zeroHopNeighbors, localHash]);
  
  // Nodes connected to local via topology edges (for topology toggle)
  const localConnectedNodes = useMemo(() => {
    const connected = new Set<string>();
    if (localHash) {
      connected.add(localHash);
      // Find all nodes with edges to/from local
      for (const edge of meshTopology.validatedEdges) {
        if (edge.fromHash === localHash) {
          connected.add(edge.toHash);
        } else if (edge.toHash === localHash) {
          connected.add(edge.fromHash);
        }
      }
    }
    return connected;
  }, [meshTopology.validatedEdges, localHash]);
  
  // Filtered polylines based on solo modes, sorted by strength (weakest first, strongest last = on top)
  const filteredCertainPolylines = useMemo(() => {
    let filtered = validatedPolylines;
    
    if (soloHubs || soloDirect) {
      filtered = validatedPolylines.filter(({ edge }) => {
        const fromHub = hubNodeSet.has(edge.fromHash);
        const toHub = hubNodeSet.has(edge.toHash);
        
        // For direct mode: edge must connect TO or FROM local directly
        const isLocalEdge = localHash && 
          (edge.fromHash === localHash || edge.toHash === localHash);
        
        if (soloHubs && soloDirect) {
          // Show hub connections OR local's direct edges
          return fromHub || toHub || isLocalEdge;
        } else if (soloHubs) {
          return fromHub || toHub;
        } else if (soloDirect) {
          // ONLY show edges that connect directly to local
          return isLocalEdge;
        }
        return true;
      });
    }
    
    // Sort by certainCount ascending (weakest rendered first = bottom, strongest last = top)
    return [...filtered].sort((a, b) => a.edge.certainCount - b.edge.certainCount);
  }, [validatedPolylines, soloHubs, soloDirect, hubNodeSet, localHash]);
  
  // Filtered neighbors based on solo modes
  const filteredNeighbors = useMemo(() => {
    if (!soloHubs && !soloDirect) return neighborsWithLocation;
    return neighborsWithLocation.filter(([hash]) => {
      const isHubConnected = hubConnectedNodes.has(hash);
      const isDirect = directNodeSet.has(hash);
      // When topology is shown, also include nodes connected to local via edges
      const isLocalConnected = showTopology && localConnectedNodes.has(hash);
      
      if (soloHubs && soloDirect) {
        return isHubConnected || isDirect || isLocalConnected;
      } else if (soloHubs) {
        return isHubConnected;
      } else if (soloDirect) {
        // Show zero-hop neighbors, OR if topology is on, show topology-connected nodes
        return isDirect || isLocalConnected;
      }
      return true;
    });
  }, [neighborsWithLocation, soloHubs, soloDirect, hubConnectedNodes, directNodeSet, showTopology, localConnectedNodes]);
  
  // ─── Edge Animation Effect (must be after filteredCertainPolylines) ───
  // Track "snapshot" of weights at animation start for smooth interpolation
  const animStartWeightsRef = useRef<Map<string, number>>(new Map());
  const animTargetWeightsRef = useRef<Map<string, number>>(new Map());
  
  useEffect(() => {
    if (!showTopology) {
      // When toggled off, reset animation state
      setEdgeAnimProgress(new Map());
      knownEdgesRef.current = new Set();
      lastEdgeSetRef.current = '';
      animStartWeightsRef.current = new Map();
      animTargetWeightsRef.current = new Map();
      setIsAnimatingInitial(false);
      return;
    }
    
    // Build current weight signature (detects both new edges and weight changes)
    const currentWeightSignature = filteredCertainPolylines
      .map(p => `${p.edge.key}:${p.edge.certainCount}`)
      .sort()
      .join(',');
    
    // Detect if this is a toggle-on (no previous edges) or data update (edges changed)
    const isInitialToggle = knownEdgesRef.current.size === 0;
    const edgesChanged = lastEdgeSetRef.current !== '' && lastEdgeSetRef.current !== currentWeightSignature;
    
    if (isInitialToggle || edgesChanged) {
      // Find new edges that need trace animation
      const newEdgeKeys: string[] = [];
      const existingEdgeKeys: string[] = [];
      
      for (const { edge } of filteredCertainPolylines) {
        if (!knownEdgesRef.current.has(edge.key)) {
          newEdgeKeys.push(edge.key);
        } else {
          existingEdgeKeys.push(edge.key);
        }
      }
      
      // CRITICAL: Capture current weights as "start" BEFORE we compute new targets
      // This snapshot is what we interpolate FROM
      if (edgesChanged && existingEdgeKeys.length > 0) {
        const startWeights = new Map<string, number>();
        for (const key of existingEdgeKeys) {
          // Use the previously stored weight (from last render cycle)
          const prevWeight = prevWeightsRef.current.get(key);
          if (prevWeight !== undefined) {
            startWeights.set(key, prevWeight);
          }
        }
        animStartWeightsRef.current = startWeights;
        setWeightAnimProgress(0);
      }
      
      // Compute and store target weights for all edges
      const targetWeights = new Map<string, number>();
      for (const { edge } of filteredCertainPolylines) {
        const weight = getLinkQualityWeight(edge.certainCount, meshTopology.maxCertainCount);
        targetWeights.set(edge.key, weight);
      }
      animTargetWeightsRef.current = targetWeights;
      
      // Initialize new edges at progress 0
      setEdgeAnimProgress(prev => {
        const next = new Map(prev);
        for (const key of newEdgeKeys) {
          next.set(key, 0);
        }
        // Ensure existing edges are at 1
        for (const key of existingEdgeKeys) {
          if (!next.has(key)) {
            next.set(key, 1);
          }
        }
        return next;
      });
      
      // Start trace animation for new edges (staggered by index)
      if (newEdgeKeys.length > 0) {
        // Mark that we're animating (prevents flash from default values)
        if (isInitialToggle) {
          setIsAnimatingInitial(true);
        }
        
        let startTime: number | null = null;
        const staggerDelay = Math.min(100, ANIMATION_DURATION / newEdgeKeys.length / 2);
        
        const animateTrace = (timestamp: number) => {
          if (!startTime) startTime = timestamp;
          const elapsed = timestamp - startTime;
          
          setEdgeAnimProgress(prev => {
            const next = new Map(prev);
            
            newEdgeKeys.forEach((key, index) => {
              const edgeStartTime = index * staggerDelay;
              const edgeElapsed = Math.max(0, elapsed - edgeStartTime);
              const progress = Math.min(edgeElapsed / ANIMATION_DURATION, 1);
              const eased = easeInOutCubic(progress);
              next.set(key, eased);
            });
            
            return next;
          });
          
          // Continue animation if not all complete
          const totalDuration = ANIMATION_DURATION + (newEdgeKeys.length - 1) * staggerDelay;
          if (elapsed < totalDuration) {
            requestAnimationFrame(animateTrace);
          } else {
            // Animation complete
            setIsAnimatingInitial(false);
          }
        };
        
        requestAnimationFrame(animateTrace);
      }
      
      // Animate weight growth for existing edges
      if (edgesChanged && existingEdgeKeys.length > 0) {
        let startTime: number | null = null;
        
        const animateWeight = (timestamp: number) => {
          if (!startTime) startTime = timestamp;
          const elapsed = timestamp - startTime;
          const progress = Math.min(elapsed / ANIMATION_DURATION, 1);
          const eased = easeInOutCubic(progress);
          
          setWeightAnimProgress(eased);
          
          if (progress < 1) {
            requestAnimationFrame(animateWeight);
          }
        };
        
        requestAnimationFrame(animateWeight);
      }
      
      // Update known edges
      for (const key of newEdgeKeys) {
        knownEdgesRef.current.add(key);
      }
    }
    
    // Update prevWeightsRef with current computed weights (for NEXT update cycle)
    for (const { edge } of filteredCertainPolylines) {
      const weight = getLinkQualityWeight(edge.certainCount, meshTopology.maxCertainCount);
      prevWeightsRef.current.set(edge.key, weight);
    }
    
    lastEdgeSetRef.current = currentWeightSignature;
  }, [showTopology, filteredCertainPolylines, meshTopology.maxCertainCount, easeInOutCubic, ANIMATION_DURATION]);

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
      {/* Map container - simple border, no glass effects */}
      <div className="h-full relative rounded-[1.125rem] overflow-hidden border border-white/10">
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
        
        {/* Draw validated topology edges - animated trace effect */}
        {showTopology && filteredCertainPolylines.map(({ from, to, edge }) => {
          // Get animation progress for this edge
          // Default to 0 (hidden) if we're in initial animation phase, otherwise 1 (fully visible)
          const defaultProgress = isAnimatingInitial ? 0 : 1;
          const traceProgress = edgeAnimProgress.get(edge.key) ?? defaultProgress;
          
          // Don't render edges that haven't started animating
          if (traceProgress <= 0) return null;
          
          // Calculate weight with smooth interpolation during weight animation
          const targetWeight = animTargetWeightsRef.current.get(edge.key) 
            ?? getLinkQualityWeight(edge.certainCount, meshTopology.maxCertainCount);
          const startWeight = animStartWeightsRef.current.get(edge.key) ?? targetWeight;
          // Interpolate from start to target based on weight animation progress
          const animatedWeight = startWeight + (targetWeight - startWeight) * weightAnimProgress;
          
          const isLoopEdge = meshTopology.loopEdgeKeys.has(edge.key);
          
          // Calculate link quality percentage for tooltip
          const linkQuality = meshTopology.maxCertainCount > 0 
            ? (edge.certainCount / meshTopology.maxCertainCount)
            : 0;
          
          // Get names for tooltip
          const fromNeighbor = neighbors[edge.fromHash];
          const toNeighbor = neighbors[edge.toHash];
          const fromName = fromNeighbor?.node_name || fromNeighbor?.name || edge.fromHash.slice(0, 8);
          const toName = toNeighbor?.node_name || toNeighbor?.name || edge.toHash.slice(0, 8);
          
          // For trace animation: interpolate the "to" position based on progress
          // This creates the "drawing" effect from point A to B
          const animatedTo: [number, number] = [
            from[0] + (to[0] - from[0]) * traceProgress,
            from[1] + (to[1] - from[1]) * traceProgress,
          ];
          
          // Opacity fades in with the trace
          const opacity = Math.min(traceProgress * 1.5, 1) * 0.7;
          
          // Loop edges: render as parallel double-lines in accent color
          if (isLoopEdge) {
            const { line1, line2 } = getParallelOffsets(from, animatedTo, animatedWeight * 1.5);
            return (
              <span key={`loop-edge-${edge.key}`}>
                {/* Double line for loop edge - indicates redundant path */}
                <Polyline
                  positions={line1}
                  pathOptions={{
                    color: DESIGN.loopEdgeColor,
                    weight: Math.max(1.5, animatedWeight * 0.6),
                    opacity: opacity * 1.3,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                />
                <Polyline
                  positions={line2}
                  pathOptions={{
                    color: DESIGN.loopEdgeColor,
                    weight: Math.max(1.5, animatedWeight * 0.6),
                    opacity: opacity * 1.3,
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
                      <div className="text-text-secondary">
                        {edge.certainCount} validations ({Math.round(linkQuality * 100)}%)
                      </div>
                      <div style={{ color: DESIGN.loopEdgeColor }} className="flex items-center gap-1 mt-0.5">
                        <RefreshCw className="w-3 h-3" />
                        <span>Redundant path</span>
                      </div>
                    </div>
                  </Tooltip>
                </Polyline>
              </span>
            );
          }
          
          // Standard edge: single gray line with trace animation
          return (
            <Polyline
              key={`edge-${edge.key}`}
              positions={[from, animatedTo]}
              pathOptions={{
                color: DESIGN.edgeColor,
                weight: animatedWeight,
                opacity,
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
                  <div className="text-text-secondary">
                    {edge.certainCount} validations ({Math.round(linkQuality * 100)}%)
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
        
        {/* Local node marker - filled, distinct blue */}
        {localNode && localNode.latitude && localNode.longitude && (
          <Marker
            position={[localNode.latitude, localNode.longitude]}
            icon={createLocalIcon()}
            eventHandlers={{
              mouseover: () => setHoveredMarker('local'),
              mouseout: () => setHoveredMarker(null),
            }}
          >
            <Popup>
              <div className="text-sm">
                <strong className="text-base">{localNode.name}</strong>
                {localHash && (
                  <span className="ml-2 font-mono text-xs text-text-muted bg-surface-elevated px-1.5 py-0.5 rounded">
                    {localHash.startsWith('0x') ? localHash.slice(2).toUpperCase() : localHash.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <br />
                <span style={{ color: DESIGN.localColor }} className="font-medium">This Node (Local)</span>
                <br />
                <span className="text-xs text-text-muted">
                  {localNode.latitude.toFixed(5)}, {localNode.longitude.toFixed(5)}
                </span>
              </div>
            </Popup>
          </Marker>
        )}
        
        {/* Neighbor markers - rings for standard nodes, filled for hubs */}
        {filteredNeighbors.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Check if this is a zero-hop neighbor or hub node
          const isZeroHop = zeroHopNeighbors.has(hash);
          const isHub = meshTopology.hubNodes.includes(hash);
          const centrality = meshTopology.centrality.get(hash) || 0;
          
          // Calculate SNR (only meaningful for zero-hop neighbors)
          const meanSnr = calculateMeanSnr(packets, hash);
          
          const name = neighbor.node_name || neighbor.name || 'Unknown';
          
          // Get full affinity data for this neighbor
          const affinity = meshTopology.fullAffinity.get(hash);
          
          // Compact hash prefix (2 chars)
          const hashPrefix = hash.startsWith('0x') ? hash.slice(2, 4).toUpperCase() : hash.slice(0, 2).toUpperCase();
          
          // Icon selection:
          // - Hubs: filled dot (indicates importance)
          // - All other nodes: ring/torus (elegant, minimal)
          const icon = isHub 
            ? createFilledIcon(DESIGN.hubColor) 
            : createRingIcon(DESIGN.nodeColor);
          
          return (
            <Marker
              key={hash}
              position={[neighbor.latitude, neighbor.longitude]}
              icon={icon}
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
                background: showTopology ? 'rgba(74, 222, 128, 0.2)' : 'rgba(20, 20, 22, 0.95)',
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
                background: soloHubs ? 'rgba(251, 191, 36, 0.25)' : 'rgba(20, 20, 22, 0.95)',
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
                background: soloDirect ? 'rgba(67, 56, 202, 0.35)' : 'rgba(20, 20, 22, 0.95)',
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
              background: 'rgba(20, 20, 22, 0.95)',
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
            background: 'rgba(20, 20, 22, 0.95)',
            borderRadius: '0.75rem',
            padding: '0.625rem',
            border: '1px solid rgba(140, 160, 200, 0.2)',
            maxWidth: '150px',
          }}
        >
          {/* Node types legend */}
          <div className="text-text-secondary font-medium mb-1.5 flex items-center gap-1">
            Nodes
            <LegendTooltip text="All nodes shown in network accent color. Hubs are filled; others are rings." />
          </div>
          <div className="flex flex-col gap-1">
            {/* Ring node indicator - thick ring like actual markers */}
            <div className="flex items-center gap-1.5">
              <div 
                className="w-3 h-3 rounded-full flex-shrink-0" 
                style={{ 
                  background: 'transparent',
                  border: `3px solid ${DESIGN.nodeColor}`,
                  boxSizing: 'border-box',
                }}
              />
              <span className="text-text-muted">Node</span>
            </div>
            {/* Hub filled indicator - no border */}
            <div className="flex items-center gap-1.5">
              <div 
                className="w-3 h-3 rounded-full flex-shrink-0" 
                style={{ 
                  backgroundColor: DESIGN.hubColor,
                }}
              />
              <span className="text-text-muted">Hub</span>
            </div>
            {/* Local node - no border */}
            <div className="flex items-center gap-1.5">
              <div 
                className="w-3 h-3 rounded-full flex-shrink-0" 
                style={{ 
                  backgroundColor: DESIGN.localColor,
                }}
              />
              <span className="text-text-muted">Local</span>
            </div>
          </div>
          
          {/* Topology stats - compact summary */}
          {showTopology && validatedPolylines.length > 0 && (
            <>
              <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1 flex items-center gap-1">
                Topology
                <LegendTooltip text="Links with 5+ validations. Thickness = relative strength." />
              </div>
              <div className="flex flex-col gap-0.5 text-text-muted">
                <div className="flex justify-between tabular-nums">
                  <span>Nodes</span>
                  <span className="text-text-secondary">{filteredNeighbors.length + (localNode ? 1 : 0)}</span>
                </div>
                <div className="flex justify-between tabular-nums">
                  <span>Links</span>
                  <span className="text-text-secondary">{filteredCertainPolylines.length}</span>
                </div>
                {meshTopology.hubNodes.length > 0 && (
                  <div className="flex justify-between tabular-nums">
                    <span>Hubs</span>
                    <span style={{ color: DESIGN.hubColor }}>{meshTopology.hubNodes.length}</span>
                  </div>
                )}
              </div>
              
              {/* Link types legend */}
              <div className="flex flex-col gap-1 mt-1.5 pt-1.5 border-t border-white/10">
                {/* Standard link */}
                <div className="flex items-center gap-1.5">
                  <div 
                    className="flex-shrink-0" 
                    style={{ 
                      width: '14px',
                      height: '3px',
                      backgroundColor: DESIGN.edgeColor,
                      borderRadius: '1px',
                    }}
                  />
                  <span className="text-text-muted">Link</span>
                </div>
                {/* Loop/redundant path indicator */}
                {meshTopology.loops.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div 
                      className="flex-shrink-0 flex flex-col gap-0.5" 
                      style={{ width: '14px' }}
                    >
                      <div style={{ 
                        height: '2px', 
                        backgroundColor: DESIGN.loopEdgeColor,
                        borderRadius: '1px',
                      }} />
                      <div style={{ 
                        height: '2px', 
                        backgroundColor: DESIGN.loopEdgeColor,
                        borderRadius: '1px',
                      }} />
                    </div>
                    <span className="text-text-muted">Redundant</span>
                  </div>
                )}
              </div>
              
              {/* Loops indicator - key resilience metric */}
              {meshTopology.loops.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-white/10">
                  <div className="flex items-center gap-1.5">
                    <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: DESIGN.loopEdgeColor }} />
                    <div className="flex flex-col">
                      <span style={{ color: DESIGN.loopEdgeColor }} className="font-medium">
                        {meshTopology.loops.length} {meshTopology.loops.length === 1 ? 'Loop' : 'Loops'}
                      </span>
                      <span className="text-text-muted text-[10px] leading-tight">
                        Redundant paths
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
