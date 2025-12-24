import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@/lib/leaflet-smooth-wheel-zoom'; // Google Maps-style smooth zoom
import { Maximize2, Minimize2, Network, ChevronsLeftRightEllipsis, GitBranch, EyeOff, Info, Copy, Check, BarChart2, RefreshCw, Home, ArrowRight, Zap, Trash2, MessagesSquare } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeighborInfo, Packet } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DeepAnalysisModal, type AnalysisStep } from '@/components/ui/DeepAnalysisModal';
import { getLinkQualityWeight, type TopologyEdge, type LastHopNeighbor } from '@/lib/mesh-topology';
import { useTopology, useIsComputingTopology } from '@/lib/stores/useTopologyStore';
import { usePackets, usePacketCacheState, useTriggerDeepAnalysis, useQuickNeighbors } from '@/lib/stores/useStore';
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
  // Local node - warm golden yellow (home icon)
  localColor: '#FBBF24',       // Amber-400
  // Hub indicator - 25% brighter, saturated royal blue-purple
  hubColor: '#6366F1',         // Indigo-500 (brighter, still saturated)
  // Mobile node indicator - warm orange (stands out from purple/blue)
  mobileColor: '#F97316',      // Orange-500 - indicates volatile/mobile node
  // Room server indicator - amber/gold (chat/server functionality)
  roomServerColor: '#F59E0B',  // Amber-500 - indicates room server node
  // Zero-hop neighbor - success green (direct RF contact)
  neighborColor: '#39D98A',    // accent-success - matches forward button
  
  // ─── EDGE COLOR HIERARCHY ───────────────────────────────────────────────────
  // Designed for dark maps - subtle but distinguishable
  edges: {
    // Backbone edges - slightly brighter to draw attention
    backbone: '#6B7280',       // Gray-500 - prominent but not glaring
    // Standard validated edges - neutral mid-gray
    standard: '#4B5563',       // Gray-600 - recedes slightly
    // Weak/emerging edges - darker, subtle
    weak: '#374151',           // Gray-700 - background layer
    // Direct path edges (ground-truth routing) - teal tint
    direct: '#5EEAD4',         // Teal-300 - distinguishes verified routes
    // Loop edges (redundant paths) - subtle purple
    loop: '#6366F1',           // Indigo-500 - indicates redundancy
    // Neighbor edges (direct RF contact) - success green
    neighbor: '#39D98A',       // accent-success - matches neighbor markers
  },
  
  // Base opacity for edges (increased from 0.7 for better visibility)
  edgeOpacity: 0.82,
};

/**
 * Get edge color based on confidence level.
 * Creates a subtle brightness gradient: low confidence = darker, high confidence = lighter.
 * Maintains the low-contrast aesthetic while providing visual differentiation.
 * 
 * @param confidence - Edge avgConfidence (0-1)
 * @param isBackbone - Whether this edge is a backbone (high-traffic) edge
 * @param isDirectPath - Whether this edge is a verified direct path
 */
function getEdgeColor(
  confidence: number,
  isBackbone: boolean = false,
  isDirectPath: boolean = false
): string {
  // Direct path edges get teal tint (verified routes)
  if (isDirectPath) {
    // Brightness varies with confidence even for direct paths
    if (confidence >= 0.9) return '#6EE7B7'; // Emerald-300 - high confidence direct
    if (confidence >= 0.75) return '#5EEAD4'; // Teal-300 - standard direct
    return '#2DD4BF'; // Teal-400 - lower confidence direct
  }
  
  // Backbone edges get lighter gray (prominent)
  if (isBackbone) {
    if (confidence >= 0.9) return '#9CA3AF'; // Gray-400 - very high confidence backbone
    if (confidence >= 0.75) return '#6B7280'; // Gray-500 - high confidence backbone
    return '#4B5563'; // Gray-600 - standard backbone
  }
  
  // Standard edges: confidence-based brightness gradient
  // Higher confidence = lighter (more visible)
  if (confidence >= 0.95) return '#6B7280'; // Gray-500 - very high confidence
  if (confidence >= 0.85) return '#4B5563'; // Gray-600 - high confidence  
  if (confidence >= 0.70) return '#374151'; // Gray-700 - medium confidence
  return '#1F2937'; // Gray-800 - low confidence (subtle)
}

/**
 * Create a ring (torus) icon for standard nodes.
 * Thick ring with small donut hole - no stroke, just the ring itself.
 * @param color - Ring color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
function createRingIcon(color: string = DESIGN.nodeColor, opacity: number = 1, isHovered: boolean = false): L.DivIcon {
  // Hover: instant on, ease-out off (150ms)
  const brightness = isHovered ? 1.25 : 1;
  return L.divIcon({
    className: 'map-ring-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background: transparent;
      border-radius: 50%;
      border: ${RING_THICKNESS}px solid ${color};
      box-sizing: border-box;
      opacity: ${opacity};
      filter: brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
  });
}

/**
 * Create a filled dot icon for hub nodes.
 * Same outer dimension as ring - no border/stroke.
 * @param color - Fill color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
function createFilledIcon(color: string = DESIGN.hubColor, opacity: number = 1, isHovered: boolean = false): L.DivIcon {
  // Hover: instant on, ease-out off (150ms)
  const brightness = isHovered ? 1.25 : 1;
  return L.divIcon({
    className: 'map-filled-marker',
    html: `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background-color: ${color};
      border-radius: 50%;
      box-sizing: border-box;
      opacity: ${opacity};
      filter: brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    "></div>`,
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
    popupAnchor: [0, -MARKER_SIZE / 2],
  });
}

/**
 * Create local node icon - yellow house icon to indicate "home" node.
 * Uses lucide-react Home icon rendered as static SVG.
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
function createLocalIcon(isHovered: boolean = false): L.DivIcon {
  // Render the Home icon to static SVG markup
  const iconMarkup = renderToStaticMarkup(
    <Home 
      size={MARKER_SIZE + 2} 
      color={DESIGN.localColor} 
      strokeWidth={2.5}
      fill="none"
    />
  );
  
  // Hover: instant on, ease-out off (150ms)
  const brightness = isHovered ? 1.25 : 1;
  
  return L.divIcon({
    className: 'map-local-marker',
    html: `<div style="
      width: ${MARKER_SIZE + 2}px;
      height: ${MARKER_SIZE + 2}px;
      display: flex;
      align-items: center;
      justify-content: center;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    ">${iconMarkup}</div>`,
    iconSize: [MARKER_SIZE + 2, MARKER_SIZE + 2],
    iconAnchor: [(MARKER_SIZE + 2) / 2, (MARKER_SIZE + 2) / 2],
    popupAnchor: [0, -(MARKER_SIZE + 2) / 2],
  });
}

/**
 * Create room server icon - amber chat bubble icon.
 * Uses lucide-react MessagesSquare icon rendered as static SVG.
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
function createRoomServerIcon(opacity: number = 1, isHovered: boolean = false): L.DivIcon {
  // Render the MessagesSquare icon to static SVG markup
  const iconMarkup = renderToStaticMarkup(
    <MessagesSquare 
      size={MARKER_SIZE + 2} 
      color={DESIGN.roomServerColor} 
      strokeWidth={2.5}
      fill="none"
    />
  );
  
  // Hover: instant on, ease-out off (150ms)
  const brightness = isHovered ? 1.25 : 1;
  
  return L.divIcon({
    className: 'map-room-server-marker',
    html: `<div style="
      width: ${MARKER_SIZE + 2}px;
      height: ${MARKER_SIZE + 2}px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: ${opacity};
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    ">${iconMarkup}</div>`,
    iconSize: [MARKER_SIZE + 2, MARKER_SIZE + 2],
    iconAnchor: [(MARKER_SIZE + 2) / 2, (MARKER_SIZE + 2) / 2],
    popupAnchor: [0, -(MARKER_SIZE + 2) / 2],
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
  selectedNodeHash?: string | null;  // Hash of node to zoom to and open popup
  onNodeSelected?: () => void;  // Callback when selection is handled
  highlightedEdgeKey?: string | null; // Edge key to highlight (from PathHealth panel)
}

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

// TX delay recommendation type (imported from topology)
interface TxDelayRec {
  txDelayFactor: number;
  directTxDelayFactor: number;
  trafficIntensity: number;
  directNeighborCount: number;
  collisionRisk: number;
  confidence: number;
  insufficientData?: boolean;
}

// Full affinity data from topology
interface FullAffinity {
  frequency: number;
  directForwardCount: number;
  typicalHopPosition: number;
  distanceMeters: number | null;
  hopPositionCounts: number[];
}

// Node popup content - compact, information-rich
interface NodePopupContentProps {
  hash: string;
  hashPrefix: string;
  name: string;
  isHub: boolean;
  isZeroHop: boolean;
  isMobile: boolean;
  isRoomServer: boolean;
  centrality: number;
  affinity?: FullAffinity;
  meanSnr?: number;
  neighbor: NeighborInfo;
  onRemove?: () => void;
  txDelayRec?: TxDelayRec;
}

// Format distance for display
function formatDistance(meters: number | null): string {
  if (meters === null) return '—';
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function NodePopupContent({ hash, hashPrefix, name, isHub, isZeroHop, isMobile, isRoomServer, centrality, affinity, meanSnr, neighbor, onRemove, txDelayRec }: NodePopupContentProps) {
  const [copied, setCopied] = useState(false);
  
  const copyHash = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  
  // Determine hop label
  const hopLabel = isZeroHop ? 'Direct' 
    : affinity?.typicalHopPosition ? `${affinity.typicalHopPosition}-hop` 
    : null;
  
  // Build dynamic third metric based on node type
  const thirdMetric = isZeroHop && meanSnr !== undefined 
    ? { label: 'SNR', value: meanSnr.toFixed(1), highlight: false }
    : isHub && centrality > 0 
    ? { label: 'Centrality', value: `${(centrality * 100).toFixed(0)}%`, highlight: true }
    : { label: 'Forwards', value: String(affinity?.directForwardCount || 0), highlight: false };
  
  // Build dynamic fourth metric
  const fourthMetric = isZeroHop && neighbor.rssi !== undefined
    ? { label: 'RSSI', value: String(neighbor.rssi) }
    : txDelayRec && !txDelayRec.insufficientData
    ? { label: 'Neighbors', value: String(txDelayRec.directNeighborCount) }
    : { label: 'Forwards', value: String(affinity?.directForwardCount || 0) };
  
  return (
    <div className="min-w-[180px] max-w-[240px]">
      {/* === HEADER: Name + Remove === */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className="text-[14px] font-semibold text-text-primary leading-snug flex-1 min-w-0">{name}</span>
        {onRemove && (
          <button
            onClick={onRemove}
            className="p-1 -mr-1 text-text-muted/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            title="Remove node"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      
      {/* === BADGES: Inline, compact === */}
      <div className="flex items-center gap-1 mb-1">
        <code className="font-mono text-[10px] text-text-muted/70 bg-white/5 px-1 py-px rounded">{hashPrefix}</code>
        <button onClick={copyHash} className="p-0.5 hover:bg-white/10 rounded transition-colors" title="Copy full hash">
          {copied ? <Check className="w-2.5 h-2.5 text-accent-success" /> : <Copy className="w-2.5 h-2.5 text-text-muted/50" />}
        </button>
        {isHub && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded" style={{ backgroundColor: '#FBBF24', color: '#000' }}>Hub</span>
        )}
        {hopLabel && (
          <span 
            className="px-1 py-px text-[8px] font-bold uppercase rounded"
            style={{ 
              backgroundColor: isZeroHop ? DESIGN.neighborColor : 'rgba(255,255,255,0.08)', 
              color: isZeroHop ? '#000' : 'rgba(255,255,255,0.5)' 
            }}
          >
            {hopLabel}
          </span>
        )}
        {isMobile && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-orange-500/25 text-orange-300" title="Volatile paths">
            Mobile
          </span>
        )}
        {neighbor.is_repeater && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-cyan-500/20 text-cyan-400">Rptr</span>
        )}
        {isRoomServer && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-amber-500/25 text-amber-400">Room</span>
        )}
      </div>
      
      {/* === META: Time, Distance, Location === */}
      <div className="text-[10px] text-text-muted/60 mb-1.5 leading-tight">
        <span>{formatRelativeTime(neighbor.last_seen)}</span>
        {affinity?.distanceMeters && (
          <span className="font-medium text-text-muted/80"> · {formatDistance(affinity.distanceMeters)}</span>
        )}
        {neighbor.latitude && neighbor.longitude && neighbor.latitude !== 0 && neighbor.longitude !== 0 && (
          <span className="font-mono text-[9px]"> · {neighbor.latitude.toFixed(4)}, {neighbor.longitude.toFixed(4)}</span>
        )}
      </div>
      
      {/* === METRICS: 2x2 grid, data-first === */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] mb-1.5">
        <div className="flex justify-between">
          <span className="text-text-muted/50">Packets</span>
          <span className="font-semibold tabular-nums">{affinity?.frequency || 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted/50">Adverts</span>
          <span className="font-semibold tabular-nums">{neighbor.advert_count || 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted/50">{thirdMetric.label}</span>
          <span className={`font-semibold tabular-nums ${thirdMetric.highlight ? 'text-amber-400' : ''}`}>{thirdMetric.value}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted/50">{fourthMetric.label}</span>
          <span className="font-semibold tabular-nums">{fourthMetric.value}</span>
        </div>
      </div>
      
      {/* === TX DELAY: Compact inline === */}
      {txDelayRec && !txDelayRec.insufficientData && (
        <div className="flex items-center gap-2 text-[10px] text-text-muted/60 bg-white/[0.02] rounded px-1.5 py-1">
          <span className="uppercase text-[8px] font-semibold tracking-wide">TX</span>
          <span>Flood <span className="font-semibold text-amber-400 tabular-nums">{txDelayRec.txDelayFactor.toFixed(2)}</span></span>
          <span>Direct <span className="font-semibold text-amber-400 tabular-nums">{txDelayRec.directTxDelayFactor.toFixed(2)}</span></span>
        </div>
      )}
    </div>
  );
}

// Highlight helper: when an edge is selected, ensure topology is visible and pan/zoom to it
function EdgeHighlighter({ highlightedEdgeKey, validatedPolylines, weakPolylines, onEnsureTopology }: { highlightedEdgeKey?: string | null; validatedPolylines: Array<{ from: [number, number]; to: [number, number]; edge: TopologyEdge; }>; weakPolylines: Array<{ from: [number, number]; to: [number, number]; edge: TopologyEdge; }>; onEnsureTopology: () => void; }) {
  const map = useMap();
  useEffect(() => {
    if (!highlightedEdgeKey) return;
    // Ensure topology is visible
    onEnsureTopology();
    // Find the edge in either set
    const line = validatedPolylines.find(l => l.edge.key === highlightedEdgeKey) || weakPolylines.find(l => l.edge.key === highlightedEdgeKey);
    if (!line) return;
    const mid: [number, number] = [
      (line.from[0] + line.to[0]) / 2,
      (line.from[1] + line.to[1]) / 2,
    ];
    // Smooth pan and a reasonable zoom level
    map.setView(mid, Math.max(map.getZoom(), 11), { animate: true });
  }, [highlightedEdgeKey, validatedPolylines, weakPolylines, map, onEnsureTopology]);
  return null;
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

// Component to zoom to a specific node and open its popup
function ZoomToNode({ targetHash, nodeCoordinates, onComplete }: { 
  targetHash: string | null; 
  nodeCoordinates: Map<string, [number, number]>;
  onComplete?: () => void;
}) {
  const map = useMap();
  const processedRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (!targetHash || targetHash === processedRef.current) return;
    
    const coords = nodeCoordinates.get(targetHash);
    if (!coords) return;
    
    processedRef.current = targetHash;
    
    // Zoom to node with smooth animation
    // easeLinearity: 0.1 creates a cubic-like ease (lower = more easing)
    map.flyTo(coords, 15, { 
      duration: 2.5,
      easeLinearity: 0.1  // Approximates easeInOutCubic
    });
    
    // After zoom completes, open the popup
    setTimeout(() => {
      // Find the marker layer and open its popup
      map.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          const pos = layer.getLatLng();
          if (Math.abs(pos.lat - coords[0]) < 0.0001 && Math.abs(pos.lng - coords[1]) < 0.0001) {
            layer.openPopup();
          }
        }
      });
      onComplete?.();
    }, 2600);
  }, [targetHash, nodeCoordinates, map, onComplete]);
  
  return null;
}

export default function ContactsMap({ neighbors, localNode, localHash, onRemoveNode, selectedNodeHash, onNodeSelected, highlightedEdgeKey }: ContactsMapProps) {
  // Track hover state per marker for brightness effect
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  
  // Confirmation modal state
  const [pendingRemove, setPendingRemove] = useState<{ hash: string; name: string } | null>(null);
  
  // Get topology from store (computed by worker)
  const meshTopology = useTopology();
  
  // Get packets for SNR calculation (lightweight, still needed)
  const packets = usePackets();
  
  // Get quick neighbors from main store (runs on every poll, persisted)
  const quickNeighbors = useQuickNeighbors();
  
  // Get zero-hop neighbors - use quickNeighbors as primary source (always available),
  // fall back to topology's lastHopNeighbors (only after deep analysis), then inference
  // Build both a Set (for .has() checks) and a Map (for looking up RSSI/SNR data)
  const { zeroHopNeighbors, lastHopNeighborMap } = useMemo(() => {
    const neighborSet = new Set<string>();
    const neighborMap = new Map<string, LastHopNeighbor>();
    
    // Primary source: quickNeighbors from main store (runs on every poll, persisted)
    // These are available immediately without deep analysis
    if (quickNeighbors.length > 0) {
      for (const qn of quickNeighbors) {
        neighborSet.add(qn.hash);
        // Convert QuickNeighbor to LastHopNeighbor-like format for compatibility
        neighborMap.set(qn.hash, {
          hash: qn.hash,
          prefix: qn.prefix,
          count: qn.count,
          confidence: 1.0, // Quick neighbors are resolved, so high confidence
          avgRssi: qn.avgRssi,
          avgSnr: qn.avgSnr,
          lastSeen: qn.lastSeen,
        });
      }
    }
    
    // Enhancement: merge in topology's lastHopNeighbors (may have more neighbors after deep analysis)
    // These may include neighbors that quickNeighbors missed due to prefix collisions
    for (const lastHop of meshTopology.lastHopNeighbors) {
      if (!neighborSet.has(lastHop.hash)) {
        neighborSet.add(lastHop.hash);
        neighborMap.set(lastHop.hash, lastHop);
      }
    }
    
    // Fallback: if still no neighbors, use the old inference method
    // This handles edge cases where both quickNeighbors and topology are empty
    if (neighborSet.size === 0) {
      const inferred = inferZeroHopNeighbors(
        packets, 
        neighbors, 
        meshTopology.validatedEdges,
        localHash
      );
      // Add inferred neighbors to the set (no LastHopNeighbor data available)
      for (const hash of inferred) {
        neighborSet.add(hash);
      }
    }
    
    return { zeroHopNeighbors: neighborSet, lastHopNeighborMap: neighborMap };
  }, [quickNeighbors, meshTopology.lastHopNeighbors, packets, neighbors, meshTopology.validatedEdges, localHash]);
  
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
  
  // Generate polylines for weak edges (5+ packets but below validation threshold)
  // These are rendered underneath validated edges as a subtle background layer
  const weakPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      edge: TopologyEdge;
    }> = [];
    
    // Build set of validated edge keys to exclude duplicates
    const validatedKeys = new Set(meshTopology.validatedEdges.map(e => e.key));
    
    for (const edge of meshTopology.weakEdges) {
      // Skip if already in validated edges (shouldn't happen but safety check)
      if (validatedKeys.has(edge.key)) continue;
      
      const fromCoords = nodeCoordinates.get(edge.fromHash);
      const toCoords = nodeCoordinates.get(edge.toHash);
      
      // Only draw if both nodes have coordinates
      if (!fromCoords || !toCoords) continue;
      
      lines.push({ from: fromCoords, to: toCoords, edge });
    }
    
    return lines;
  }, [meshTopology, nodeCoordinates]);
  
  // Generate polylines for neighbor edges (direct RF links from local to zero-hop neighbors)
  // These are ALWAYS visible - not gated by topology toggle - since they represent real API neighbor data
  // Uses lastHopNeighbor data from topology for RSSI/SNR when available (computed from actual packets)
  const neighborPolylines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      hash: string;  // neighbor hash for link quality lookup
      neighbor: NeighborInfo;
      lastHopData: LastHopNeighbor | null;  // Topology-computed RSSI/SNR data
    }> = [];
    
    // Get local node coordinates
    const localCoords = nodeCoordinates.get('local');
    if (!localCoords) return lines;
    
    // Draw lines to all zero-hop neighbors with coordinates
    for (const neighborHash of zeroHopNeighbors) {
      const neighborCoords = nodeCoordinates.get(neighborHash);
      if (!neighborCoords) continue;
      
      const neighbor = neighbors[neighborHash];
      if (!neighbor) continue;
      
      // Get topology-computed RSSI/SNR data if available
      const lastHopData = lastHopNeighborMap.get(neighborHash) || null;
      
      lines.push({
        from: localCoords,
        to: neighborCoords,
        hash: neighborHash,
        neighbor,
        lastHopData,
      });
    }
    
    return lines;
  }, [nodeCoordinates, zeroHopNeighbors, neighbors, lastHopNeighborMap]);
  
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
  // Node Fade Animation System (for Solo modes: Direct and Hubs)
  // Staggered fade with randomized delays for organic feel
  // ═══════════════════════════════════════════════════════════════════════════════
  const [nodeOpacities, setNodeOpacities] = useState<Map<string, number>>(new Map());
  const NODE_FADE_DURATION = 500; // 0.5s
  const MAX_NODE_STAGGER_DELAY = 250; // Max 250ms stagger spread
  const prevSoloDirectRef = useRef(soloDirect);
  const prevSoloHubsRef = useRef(soloHubs);
  const nodeStaggerDelaysRef = useRef<Map<string, number>>(new Map());
  const nodeAnimationFrameRef = useRef<number | null>(null);
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // Deep Analysis System
  // ═══════════════════════════════════════════════════════════════════════════════
  
  const packetCacheState = usePacketCacheState();
  const isComputingTopology = useIsComputingTopology();
  const triggerDeepAnalysis = useTriggerDeepAnalysis();
  
  // Modal visibility and progress state
  const [showDeepAnalysisModal, setShowDeepAnalysisModal] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<AnalysisStep>('fetching');
  
  // Track previous state to detect step transitions
  const wasDeepLoadingRef = useRef(false);
  const wasComputingRef = useRef(false);
  
  // Track when building step started (for minimum display time)
  const buildingStartTimeRef = useRef<number>(0);
  
  // Minimum time to show "Building Topology" step (1.7s)
  const MIN_BUILDING_TIME_MS = 1700;
  // Time to show "Ready!" state before closing (1s)
  const READY_DISPLAY_TIME_MS = 1000;
  // Delay after modal closes before starting edge animation (let user see the map)
  const POST_MODAL_ANIMATION_DELAY_MS = 150;
  
  // Track if we need to trigger topology animation after modal closes
  const [pendingTopologyReveal, setPendingTopologyReveal] = useState(false);
  
  // Extract primitive values to avoid object reference changes triggering infinite loops
  const isDeepLoading = packetCacheState.isDeepLoading;
  
  // Derive analysis step from packet cache and topology states
  useEffect(() => {
    if (!showDeepAnalysisModal) return;
    
    // Step 1 → 2: Fetching complete, start analyzing
    if (wasDeepLoadingRef.current && !isDeepLoading) {
      setAnalysisStep('analyzing');
      // Brief pause to show "analyzing" before topology compute starts
      setTimeout(() => {
        setAnalysisStep('building');
        buildingStartTimeRef.current = Date.now();
      }, 300);
    }
    
    // Step 3 → complete: Topology compute finished
    // Trigger when: we're in building step AND topology is not computing
    // (either it finished, or it was already done before we started)
    if (analysisStep === 'building' && !isComputingTopology && buildingStartTimeRef.current > 0) {
      const elapsed = Date.now() - buildingStartTimeRef.current;
      const remainingDelay = Math.max(0, MIN_BUILDING_TIME_MS - elapsed);
      
      // Reset to prevent re-triggering
      buildingStartTimeRef.current = 0;
      
      setTimeout(() => {
        setAnalysisStep('complete');
        // Show "Ready!" state for 1s before closing
        setTimeout(() => {
          // Close modal first, mark topology reveal as pending
          setShowDeepAnalysisModal(false);
          setAnalysisStep('fetching');
          setPendingTopologyReveal(true);
        }, READY_DISPLAY_TIME_MS);
      }, remainingDelay);
    }
    
    wasDeepLoadingRef.current = isDeepLoading;
    wasComputingRef.current = isComputingTopology;
  }, [showDeepAnalysisModal, isDeepLoading, isComputingTopology, analysisStep]);
  
  // Trigger topology animation AFTER modal has closed
  useEffect(() => {
    if (pendingTopologyReveal && !showDeepAnalysisModal) {
      // Small delay to let the modal fully unmount and user see the map
      const timer = setTimeout(() => {
        // Force a fresh animation by resetting all edge state first
        // This ensures edges animate even if topology was already "on"
        setEdgeAnimProgress(new Map());
        knownEdgesRef.current = new Set();
        lastEdgeSetRef.current = '';
        
        // Now enable topology - the animation effect will trigger
        setShowTopology(true);
        setPendingTopologyReveal(false);
      }, POST_MODAL_ANIMATION_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [pendingTopologyReveal, showDeepAnalysisModal]);
  
  // Handler for Deep Analysis button
  const handleDeepAnalysis = useCallback(() => {
    setShowDeepAnalysisModal(true);
    setAnalysisStep('fetching');
    wasDeepLoadingRef.current = true; // Prime for transition detection
    wasComputingRef.current = false;
    triggerDeepAnalysis();
  }, [triggerDeepAnalysis]);
  
  // Handler to close DeepAnalysisModal (ESC or manual close)
  // Gracefully resets state without breaking ongoing processes
  const handleCloseDeepAnalysis = useCallback(() => {
    setShowDeepAnalysisModal(false);
    setAnalysisStep('fetching');
    // Reset tracking refs to clean state
    wasDeepLoadingRef.current = false;
    wasComputingRef.current = false;
    buildingStartTimeRef.current = 0;
    // Don't trigger topology reveal if closed mid-process
    setPendingTopologyReveal(false);
  }, []);
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // Edge Animation System (state declarations - effect is after filteredCertainPolylines)
  // - "Trace" effect: lines draw from point A to B
  // - Thickness growth: existing edges animate to new weight when data changes
  // ═══════════════════════════════════════════════════════════════════════════════
  
  const ANIMATION_DURATION = 2000; // 2 seconds
  
  // Track animation progress per edge (0 = not started, 1 = complete)
  const [edgeAnimProgress, setEdgeAnimProgress] = useState<Map<string, number>>(new Map());
  
  // Hover state for edge highlighting
  // When hovering an edge: brighten it, dim all others
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  
  // Track previous weights for thickness animation
  const prevWeightsRef = useRef<Map<string, number>>(new Map());
  const [weightAnimProgress, setWeightAnimProgress] = useState(1); // 0-1 for weight interpolation
  
  // Track which edges we've seen before (for detecting new edges)
  const knownEdgesRef = useRef<Set<string>>(new Set());
  
  // Track the last edge set to detect changes (for "pull more data" scenario)
  const lastEdgeSetRef = useRef<string>('');
  
  // Cubic ease-in-out helper
  const easeInOutCubic = (t: number): number => {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  
  // Build set of hub nodes and zero-hop nodes for filtering
  const hubNodeSet = useMemo(() => new Set(meshTopology.hubNodes), [meshTopology.hubNodes]);
  
  // Identify backbone edges (by betweenness centrality, with fallback to top-3-by-count)
  const backboneEdgeKeys = useMemo(() => {
    // Prefer betweenness-based backbone if available
    if (meshTopology.backboneEdges && meshTopology.backboneEdges.length > 0) {
      return new Set(meshTopology.backboneEdges);
    }
    // Fallback to top 3 by certainCount
    const sorted = [...meshTopology.validatedEdges].sort((a, b) => b.certainCount - a.certainCount);
    return new Set(sorted.slice(0, 3).map(e => e.key));
  }, [meshTopology.backboneEdges, meshTopology.validatedEdges]);
  
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
  
  // Keep refs for visibility computation (to avoid stale closures in animation)
  const hubConnectedNodesRef = useRef(hubConnectedNodes);
  const directNodeSetRef = useRef(directNodeSet);
  const localConnectedNodesRef = useRef(localConnectedNodes);
  const showTopologyRef = useRef(showTopology);
  const neighborsWithLocationRef = useRef(neighborsWithLocation);
  
  // Update refs when values change
  useEffect(() => {
    hubConnectedNodesRef.current = hubConnectedNodes;
    directNodeSetRef.current = directNodeSet;
    localConnectedNodesRef.current = localConnectedNodes;
    showTopologyRef.current = showTopology;
    neighborsWithLocationRef.current = neighborsWithLocation;
  }, [hubConnectedNodes, directNodeSet, localConnectedNodes, showTopology, neighborsWithLocation]);
  
  // ─── Node Fade Animation Effect (for Solo modes: Direct and Hubs) ───
  // Staggered fade in/out with randomized delays for organic feel
  useEffect(() => {
    const wasDirectMode = prevSoloDirectRef.current;
    const wasHubsMode = prevSoloHubsRef.current;
    const isDirectMode = soloDirect;
    const isHubsMode = soloHubs;
    prevSoloDirectRef.current = soloDirect;
    prevSoloHubsRef.current = soloHubs;
    
    // Detect which mode changed
    const directChanged = wasDirectMode !== isDirectMode;
    const hubsChanged = wasHubsMode !== isHubsMode;
    
    // Skip if no change
    if (!directChanged && !hubsChanged) return;
    
    // Cancel any existing animation
    if (nodeAnimationFrameRef.current) {
      cancelAnimationFrame(nodeAnimationFrameRef.current);
      nodeAnimationFrameRef.current = null;
    }
    
    // Use refs to get current values (avoids stale closures)
    const hubConnected = hubConnectedNodesRef.current;
    const directNodes = directNodeSetRef.current;
    const localConnected = localConnectedNodesRef.current;
    const topologyOn = showTopologyRef.current;
    const neighbors = neighborsWithLocationRef.current;
    
    // Get all neighbor hashes
    const allNeighborHashes = neighbors.map(([hash]) => hash);
    
    // Generate random stagger delays (only once per node, persisted across toggles)
    for (const hash of allNeighborHashes) {
      if (!nodeStaggerDelaysRef.current.has(hash)) {
        nodeStaggerDelaysRef.current.set(hash, Math.random());
      }
    }
    
    // Helper: determine if node should be visible given mode state
    const isVisibleInMode = (hash: string, directMode: boolean, hubsMode: boolean): boolean => {
      const isHubConnected = hubConnected.has(hash);
      const isDirect = directNodes.has(hash);
      const isLocalConnected = topologyOn && localConnected.has(hash);
      
      if (!directMode && !hubsMode) return true;
      if (directMode && hubsMode) return isHubConnected || isDirect || isLocalConnected;
      if (hubsMode) return isHubConnected;
      if (directMode) return isDirect || isLocalConnected;
      return true;
    };
    
    // Build animation targets - only for nodes whose visibility actually changed
    const animationTargets: Array<{ hash: string; startOpacity: number; targetOpacity: number }> = [];
    
    console.log('[ContactsMap] Animation effect triggered:', {
      wasDirectMode, wasHubsMode, isDirectMode, isHubsMode,
      hubConnectedSize: hubConnected.size,
      directNodesSize: directNodes.size,
      neighborsCount: allNeighborHashes.length,
    });
    
    for (const hash of allNeighborHashes) {
      const wasVisible = isVisibleInMode(hash, wasDirectMode, wasHubsMode);
      const nowVisible = isVisibleInMode(hash, isDirectMode, isHubsMode);
      
      // Only animate if visibility changed
      if (wasVisible !== nowVisible) {
        animationTargets.push({
          hash,
          startOpacity: wasVisible ? 1 : 0,
          targetOpacity: nowVisible ? 1 : 0,
        });
      }
    }
    
    console.log('[ContactsMap] Animation targets:', animationTargets.length, 'nodes to animate');
    
    if (animationTargets.length === 0) return;
    
    // Initialize animating nodes to their start opacity
    setNodeOpacities(prev => {
      const next = new Map(prev);
      for (const { hash, startOpacity } of animationTargets) {
        next.set(hash, startOpacity);
      }
      return next;
    });
    
    // Capture targets for animation closure
    const targets = animationTargets;
    
    let startTime: number | null = null;
    const animateNodes = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      
      let allComplete = true;
      
      setNodeOpacities(() => {
        const next = new Map<string, number>();
        
        for (const { hash, startOpacity, targetOpacity } of targets) {
          const staggerDelay = (nodeStaggerDelaysRef.current.get(hash) ?? 0) * MAX_NODE_STAGGER_DELAY;
          const nodeElapsed = Math.max(0, elapsed - staggerDelay);
          const progress = Math.min(nodeElapsed / NODE_FADE_DURATION, 1);
          const eased = easeInOutCubic(progress);
          
          // Interpolate between start and target
          const opacity = startOpacity + (targetOpacity - startOpacity) * eased;
          next.set(hash, opacity);
          
          if (progress < 1) allComplete = false;
        }
        
        return next;
      });
      
      const totalDuration = NODE_FADE_DURATION + MAX_NODE_STAGGER_DELAY;
      if (elapsed < totalDuration && !allComplete) {
        nodeAnimationFrameRef.current = requestAnimationFrame(animateNodes);
      } else {
        nodeAnimationFrameRef.current = null;
        // Animation complete - clear opacity map so nodes use default visibility
        setNodeOpacities(new Map());
      }
    };
    
    nodeAnimationFrameRef.current = requestAnimationFrame(animateNodes);
    
    // Cleanup on unmount
    return () => {
      if (nodeAnimationFrameRef.current) {
        cancelAnimationFrame(nodeAnimationFrameRef.current);
        nodeAnimationFrameRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soloDirect, soloHubs]);
  
  // ─── Edge Animation Effect (must be after filteredCertainPolylines) ───
  // Track "snapshot" of weights at animation start for smooth interpolation
  const animStartWeightsRef = useRef<Map<string, number>>(new Map());
  const animTargetWeightsRef = useRef<Map<string, number>>(new Map());
  
  // Exit animation state - retract edges when topology is toggled off
  const [isExiting, setIsExiting] = useState(false);
  const prevShowTopologyRef = useRef(showTopology);
  const edgeAnimProgressRef = useRef<Map<string, number>>(new Map());
  const EXIT_ANIMATION_DURATION = 500; // 0.5s quick "zip" retraction
  
  // Keep ref in sync with state (for capturing in animation)
  useEffect(() => {
    edgeAnimProgressRef.current = edgeAnimProgress;
  }, [edgeAnimProgress]);
  
  // Cubic ease-out for snappy retraction
  const easeOutCubic = useCallback((t: number): number => {
    return 1 - Math.pow(1 - t, 3);
  }, []);
  
  // Handle topology toggle - detect changes and trigger exit animation
  useEffect(() => {
    const wasShowing = prevShowTopologyRef.current;
    const isShowing = showTopology;
    prevShowTopologyRef.current = showTopology;
    
    // Toggling OFF: start exit animation (retract edges toward nodes)
    if (wasShowing && !isShowing && !isExiting) {
      setIsExiting(true);
      
      // Capture current edge progress values as starting points for retraction
      const startProgressMap = new Map(edgeAnimProgressRef.current);
      
      let startTime: number | null = null;
      const animateExit = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / EXIT_ANIMATION_DURATION, 1);
        const eased = easeOutCubic(progress); // Quick ease-out for "zip" effect
        
        // Retract each edge from its current progress toward 0
        setEdgeAnimProgress(() => {
          const next = new Map<string, number>();
          for (const [key, startVal] of startProgressMap) {
            // Interpolate from startVal → 0
            next.set(key, startVal * (1 - eased));
          }
          return next;
        });
        
        if (progress < 1) {
          requestAnimationFrame(animateExit);
        } else {
          // Exit animation complete - fully reset state
          setIsExiting(false);
          setEdgeAnimProgress(new Map());
          knownEdgesRef.current = new Set();
          lastEdgeSetRef.current = '';
          animStartWeightsRef.current = new Map();
          animTargetWeightsRef.current = new Map();
        }
      };
      
      requestAnimationFrame(animateExit);
    }
    
    // Toggling ON: reset edge state for fresh animation start
    if (!wasShowing && isShowing) {
      // Reset all edge animation state - edges default to 0 until animated
      setEdgeAnimProgress(new Map());
      knownEdgesRef.current = new Set();
      lastEdgeSetRef.current = '';
    }
  }, [showTopology, isExiting, easeOutCubic]);
  
  useEffect(() => {
    // Skip if we're in exit animation or topology is off
    if (!showTopology || isExiting) {
      return;
    }
    
    // Combine validated and weak edges for animation
    const allAnimatedEdges = [...filteredCertainPolylines, ...weakPolylines];
    
    // Build current weight signature (detects both new edges and weight changes)
    const currentWeightSignature = allAnimatedEdges
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
      
      for (const { edge } of allAnimatedEdges) {
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
  }, [showTopology, isExiting, filteredCertainPolylines, weakPolylines, meshTopology.maxCertainCount, easeInOutCubic, ANIMATION_DURATION]);

  // Toggle fullscreen - cross-platform support
  // iOS doesn't support Fullscreen API, so we use CSS-based fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!mapContainerRef.current) return;
    
    const elem = mapContainerRef.current as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
      msRequestFullscreen?: () => void;
    };
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      msExitFullscreen?: () => void;
      webkitFullscreenElement?: Element;
      msFullscreenElement?: Element;
    };
    
    // Check if native fullscreen is supported
    const nativeFullscreenSupported = !!(elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen);
    
    if (!isFullscreen) {
      if (nativeFullscreenSupported) {
        // Try native fullscreen APIs in order of preference
        if (elem.requestFullscreen) {
          elem.requestFullscreen().catch(() => {
            // Fallback to CSS fullscreen if native fails
            setIsFullscreen(true);
          });
        } else if (elem.webkitRequestFullscreen) {
          elem.webkitRequestFullscreen();
        } else if (elem.msRequestFullscreen) {
          elem.msRequestFullscreen();
        }
      } else {
        // iOS/unsupported: use CSS-based fullscreen
        setIsFullscreen(true);
      }
    } else {
      // Exit fullscreen
      const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
      
      if (fullscreenElement) {
        // Native fullscreen active - exit it
        if (doc.exitFullscreen) {
          doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          doc.webkitExitFullscreen();
        } else if (doc.msExitFullscreen) {
          doc.msExitFullscreen();
        }
      } else {
        // CSS-based fullscreen - just toggle state
        setIsFullscreen(false);
      }
    }
  }, [isFullscreen]);

  // Listen for fullscreen changes (native API)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const doc = document as Document & {
        webkitFullscreenElement?: Element;
        msFullscreenElement?: Element;
      };
      const isNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
      setIsFullscreen(isNativeFullscreen);
    };
    
    // Listen for all vendor-prefixed events
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);
  
  // Handle escape key for CSS-based fullscreen (native handles its own)
  useEffect(() => {
    if (!isFullscreen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Check if we're in CSS-based fullscreen (not native)
        const doc = document as Document & {
          webkitFullscreenElement?: Element;
          msFullscreenElement?: Element;
        };
        const isNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
        if (!isNativeFullscreen) {
          setIsFullscreen(false);
        }
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);
  
  // Lock body scroll when in CSS-based fullscreen (prevents iOS background scroll)
  useEffect(() => {
    if (!isFullscreen) return;
    
    // Check if this is CSS-based fullscreen (not native)
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      msFullscreenElement?: Element;
    };
    const isNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
    
    if (!isNativeFullscreen) {
      // CSS-based fullscreen - lock body scroll
      const scrollY = window.scrollY;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
      
      return () => {
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        window.scrollTo(0, scrollY);
      };
    }
  }, [isFullscreen]);

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
  
  // CSS-based fullscreen styles (for iOS and fallback)
  const fullscreenStyles: React.CSSProperties = isFullscreen ? {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100vw',
    height: '100dvh', // dvh = dynamic viewport height (accounts for iOS Safari address bar)
    zIndex: 9999,
    borderRadius: 0,
  } : {
    height: '500px',
  };
  
  return (
    <div 
      ref={mapContainerRef}
      className={`relative overflow-hidden ${isFullscreen ? '' : 'glass-card'}`}
      style={fullscreenStyles}
    >
      {/* Map container */}
      <div className={`h-full relative overflow-hidden ${isFullscreen ? '' : 'rounded-[1.125rem]'}`}>
        <MapContainer
          center={defaultCenter}
          zoom={8}
          scrollWheelZoom={false}
          smoothWheelZoom={true}
          smoothSensitivity={1.5}
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
        <EdgeHighlighter highlightedEdgeKey={highlightedEdgeKey} validatedPolylines={validatedPolylines} weakPolylines={weakPolylines} onEnsureTopology={() => setShowTopology(true)} />
        <ZoomToNode targetHash={selectedNodeHash || null} nodeCoordinates={nodeCoordinates} onComplete={onNodeSelected} />
        
        {/* Draw weak topology edges (underneath) - subtle 10% gray for emerging connections */}
        {(showTopology || isExiting) && weakPolylines.map(({ from, to, edge }) => {
          // Use same trace animation system but with simpler rendering
          const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
          
          // Don't render edges that haven't started animating
          if (traceProgress <= 0) return null;
          
          // Animate the "to" position for trace effect
          const animatedTo: [number, number] = [
            from[0] + (to[0] - from[0]) * traceProgress,
            from[1] + (to[1] - from[1]) * traceProgress,
          ];
          
          return (
            <Polyline
              key={`weak-edge-${edge.key}`}
              positions={[from, animatedTo]}
              pathOptions={{
                color: DESIGN.edges.weak,
                weight: 1.5,
                opacity: 0.5 * traceProgress,  // Subtle but visible
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          );
        })}
        
        {/* Draw validated topology edges - animated trace effect */}
        {(showTopology || isExiting) && filteredCertainPolylines.map(({ from, to, edge }) => {
          // Get animation progress for this edge
          // ALWAYS default to 0 - edges must be explicitly animated in
          // The animation effect will set progress > 0 when ready
          const traceProgress = edgeAnimProgress.get(edge.key) ?? 0;
          
          // Don't render edges that haven't started animating (or have fully retracted)
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
          
          // Opacity scales with trace progress - use new base opacity
          const baseOpacity = Math.min(traceProgress * 1.5, 1) * DESIGN.edgeOpacity;
          
          // Check edge properties for color selection
          const isBackbone = backboneEdgeKeys.has(edge.key);
          const confidence = edge.avgConfidence ?? 0.7;
          
          // Hover effect: dim non-hovered edges when any edge is hovered
          const isHovered = hoveredEdgeKey === edge.key;
          const isAnyHovered = hoveredEdgeKey !== null;
          const hoverOpacityMult = isAnyHovered ? (isHovered ? 1.25 : 0.4) : 1;
          
          // Loop edges: render as parallel double-lines in loop color
          if (isLoopEdge) {
            const { line1, line2 } = getParallelOffsets(from, animatedTo, animatedWeight * 1.5);
            const loopColor = DESIGN.edges.loop;
            // Brighten hovered loop edge
            const loopOpacity = baseOpacity * 1.1 * hoverOpacityMult;
            const loopWeight = isHovered 
              ? Math.max(2.5, animatedWeight * 0.8) 
              : Math.max(1.5, animatedWeight * 0.6);
            return (
              <span key={`loop-edge-${edge.key}`}>
                {/* Double line for loop edge - indicates redundant path */}
                <Polyline
                  positions={line1}
                  pathOptions={{
                    color: loopColor,
                    weight: loopWeight,
                    opacity: loopOpacity,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                  eventHandlers={{
                    mouseover: () => setHoveredEdgeKey(edge.key),
                    mouseout: () => setHoveredEdgeKey(null),
                  }}
                />
                <Polyline
                  positions={line2}
                  pathOptions={{
                    color: loopColor,
                    weight: loopWeight,
                    opacity: loopOpacity,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                  eventHandlers={{
                    mouseover: () => setHoveredEdgeKey(edge.key),
                    mouseout: () => setHoveredEdgeKey(null),
                  }}
                >
                <Tooltip
                    permanent={false}
                    direction="auto"
                    className="topology-edge-tooltip"
                  >
                    <div className="text-xs">
                      {/* Show directional indicator if asymmetric */}
                      {(edge.symmetryRatio ?? 1) < 0.7 && edge.dominantDirection !== 'balanced' ? (
                        <div className="font-medium text-text-primary flex items-center gap-1">
                          {edge.dominantDirection === 'forward' ? (
                            <>{fromName} <ArrowRight className="w-3 h-3" /> {toName}</>
                          ) : (
                            <>{toName} <ArrowRight className="w-3 h-3" /> {fromName}</>
                          )}
                        </div>
                      ) : (
                        <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
                      )}
                      <div className="text-text-secondary">
                        {edge.certainCount} validations ({Math.round(linkQuality * 100)}%)
                      </div>
                      <div style={{ color: loopColor }} className="flex items-center gap-1 mt-0.5">
                        <RefreshCw className="w-3 h-3" />
                        <span>Redundant path</span>
                      </div>
                      {edge.isDirectPathEdge && (
                        <div className="text-teal-400 flex items-center gap-1">
                          <Zap className="w-3 h-3" />
                          <span>Direct path</span>
                        </div>
                      )}
                    </div>
                  </Tooltip>
                </Polyline>
              </span>
            );
          }
          
          // Get confidence-based color for this edge
          // Direct path edges get teal tint, backbone edges get lighter gray
          const edgeColor = getEdgeColor(confidence, isBackbone, edge.isDirectPathEdge);
          
          // Standard edge: single line with trace animation
          const isHighlighted = highlightedEdgeKey && edge.key === highlightedEdgeKey;
          
          // Weight adjustments: backbone edges slightly thicker, hovered edges bolder
          let finalWeight = isHighlighted 
            ? Math.max(animatedWeight * 1.6, 4.5) 
            : (isBackbone ? animatedWeight * 1.3 : animatedWeight);
          // Boost weight slightly when hovered (if not already highlighted)
          if (isHovered && !isHighlighted) {
            finalWeight = Math.max(finalWeight * 1.2, 3);
          }
          
          // Opacity: highlighted edges full opacity, backbone slightly higher
          // Apply hover dimming/brightening
          let finalOpacity = isHighlighted 
            ? 0.95 
            : (isBackbone ? baseOpacity * 1.15 : baseOpacity);
          finalOpacity *= hoverOpacityMult;
          
          return (
            <Polyline
              key={`edge-${edge.key}`}
              positions={[from, animatedTo]}
              pathOptions={{
                color: isHighlighted ? '#FFD700' : edgeColor,
                weight: finalWeight,
                opacity: finalOpacity,
                lineCap: 'round',
                lineJoin: 'round',
              }}
              eventHandlers={{
                mouseover: () => setHoveredEdgeKey(edge.key),
                mouseout: () => setHoveredEdgeKey(null),
              }}
            >
              <Tooltip
                permanent={false}
                direction="auto"
                className="topology-edge-tooltip"
              >
                <div className="text-xs">
                  {/* Show directional indicator if asymmetric */}
                  {(edge.symmetryRatio ?? 1) < 0.7 && edge.dominantDirection !== 'balanced' ? (
                    <div className="font-medium text-text-primary flex items-center gap-1">
                      {edge.dominantDirection === 'forward' ? (
                        <>{fromName} <ArrowRight className="w-3 h-3" /> {toName}</>
                      ) : (
                        <>{toName} <ArrowRight className="w-3 h-3" /> {fromName}</>
                      )}
                    </div>
                  ) : (
                    <div className="font-medium text-text-primary">{fromName} ↔ {toName}</div>
                  )}
                  <div className="text-text-secondary">
                    {edge.certainCount} validations ({Math.round(linkQuality * 100)}%) • {Math.round(confidence * 100)}% conf
                  </div>
                  {isBackbone && (
                    <div className="text-gray-300 font-semibold">Backbone</div>
                  )}
                  {edge.isDirectPathEdge && (
                    <div className="text-teal-400 flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      <span>Direct path</span>
                    </div>
                  )}
                  {edge.isHubConnection && !isBackbone && !edge.isDirectPathEdge && (
                    <div className="text-amber-400">Hub connection</div>
                  )}
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
        {/* Note: Uncertain edges are no longer rendered - only validated (3+) topology shown */}
        
        {/* Draw neighbor edges (direct RF links to local) - green, always visible */}
        {/* Weight based on signal strength: higher RSSI = thicker line */}
        {/* Uses topology-computed avgRssi/avgSnr when available (from lastHopNeighbors) */}
        {neighborPolylines.map(({ from, to, hash, neighbor, lastHopData }) => {
          const name = neighbor.node_name || neighbor.name || hash.slice(0, 8);
          
          // Prefer topology-computed RSSI/SNR (averaged from actual packets) over API snapshot
          const snr = lastHopData?.avgSnr ?? neighbor.snr;
          const rssi = lastHopData?.avgRssi ?? neighbor.rssi;
          const packetCount = lastHopData?.count;
          const confidence = lastHopData?.confidence;
          
          // Weight scales with RSSI: -50 dBm = 4px, -120 dBm = 1.5px
          const minWeight = 1.5;
          const maxWeight = 4;
          const minRssi = -120;
          const maxRssi = -50;
          let weight = minWeight;
          if (rssi !== undefined && rssi !== null) {
            const normalized = Math.max(0, Math.min(1, (rssi - minRssi) / (maxRssi - minRssi)));
            weight = minWeight + normalized * (maxWeight - minWeight);
          }
          
          return (
            <Polyline
              key={`neighbor-edge-${hash}`}
              positions={[from, to]}
              pathOptions={{
                color: DESIGN.edges.neighbor,
                weight,
                opacity: 0.75,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            >
              <Tooltip
                permanent={false}
                direction="auto"
                className="topology-edge-tooltip"
              >
                <div className="text-xs">
                  <div className="font-medium text-text-primary">
                    <span className="text-accent-success">●</span> {name}
                    {lastHopData?.prefix && (
                      <span className="ml-1 text-text-muted font-mono text-[10px]">
                        ({lastHopData.prefix})
                      </span>
                    )}
                  </div>
                  <div className="text-text-secondary flex gap-2">
                    {rssi !== undefined && rssi !== null && (
                      <span>RSSI: {Math.round(rssi)} dBm{lastHopData?.avgRssi && ' avg'}</span>
                    )}
                    {snr !== undefined && snr !== null && (
                      <span>SNR: {snr.toFixed(1)} dB{lastHopData?.avgSnr && ' avg'}</span>
                    )}
                  </div>
                  {packetCount !== undefined && (
                    <div className="text-text-muted text-[10px]">
                      {packetCount.toLocaleString()} packets
                      {confidence !== undefined && ` • ${Math.round(confidence * 100)}% conf`}
                    </div>
                  )}
                  <div className="text-accent-success text-[10px] mt-0.5">Direct RF neighbor</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}
        
        {/* Neighbor markers - rings for standard nodes, filled for hubs */}
        {/* Use neighborsWithLocation for fade animation, but apply visibility rules */}
        {neighborsWithLocation.map(([hash, neighbor]) => {
          if (!neighbor.latitude || !neighbor.longitude) return null;
          
          // Check if this is a zero-hop neighbor or hub node
          const isZeroHop = zeroHopNeighbors.has(hash);
          const isHub = meshTopology.hubNodes.includes(hash);
          const centrality = meshTopology.centrality.get(hash) || 0;
          
          // Visibility calculation - should this node be shown given solo modes?
          const isHubConnected = hubConnectedNodes.has(hash);
          const isDirect = directNodeSet.has(hash);
          const isLocalConnected = showTopology && localConnectedNodes.has(hash);
          
          let shouldShow = true;
          if (soloHubs || soloDirect) {
            if (soloHubs && soloDirect) {
              shouldShow = isHubConnected || isDirect || isLocalConnected;
            } else if (soloHubs) {
              shouldShow = isHubConnected;
            } else if (soloDirect) {
              shouldShow = isDirect || isLocalConnected;
            }
          }
          
          // Get animated opacity from state
          // - If node is in animation state, use that opacity
          // - If no animation active, use 1 for visible nodes, 0 for hidden
          const nodeOpacity = nodeOpacities.has(hash) 
            ? nodeOpacities.get(hash)! 
            : (shouldShow ? 1 : 0);
          
          // Don't render if opacity is effectively 0 (hidden)
          if (nodeOpacity <= 0.01) return null;
          
          // Calculate SNR (only meaningful for zero-hop neighbors)
          const meanSnr = calculateMeanSnr(packets, hash);
          
          const name = neighbor.node_name || neighbor.name || 'Unknown';
          
          // Get full affinity data for this neighbor
          const affinity = meshTopology.fullAffinity.get(hash);
          
          // Compact hash prefix (2 chars)
          const hashPrefix = hash.startsWith('0x') ? hash.slice(2, 4).toUpperCase() : hash.slice(0, 2).toUpperCase();
          
          // Check if this is a mobile node
          const isMobile = meshTopology.mobileNodes.includes(hash);
          
          // Check if this is a room server (by contact_type field)
          // API returns "Room Server" (with space), handle both formats
          const isRoomServer = neighbor.contact_type?.toLowerCase() === 'room server'
            || neighbor.contact_type?.toLowerCase() === 'room_server' 
            || neighbor.contact_type?.toLowerCase() === 'room' 
            || neighbor.contact_type?.toLowerCase() === 'server';
          
          // Icon selection with opacity and hover state:
          // Priority: Room Server > Hub > Zero-hop Neighbor > Mobile > Standard
          // - Room servers: amber chat bubble icon (service node)
          // - Hubs: filled dot (indicates importance)
          // - Zero-hop neighbors: green ring (direct RF contact)
          // - Mobile nodes: orange ring (indicates volatile/moving)
          // - All other nodes: ring/torus in standard color (elegant, minimal)
          // Quantize opacity to 20 steps for smooth-ish animation without too many remounts
          const quantizedOpacity = Math.round(nodeOpacity * 20) / 20;
          const isNodeHovered = hoveredMarker === hash;
          const icon = isRoomServer
            ? createRoomServerIcon(quantizedOpacity, isNodeHovered)
            : isHub 
              ? createFilledIcon(DESIGN.hubColor, quantizedOpacity, isNodeHovered)
              : isZeroHop
                ? createRingIcon(DESIGN.neighborColor, quantizedOpacity, isNodeHovered)
                : isMobile
                  ? createRingIcon(DESIGN.mobileColor, quantizedOpacity, isNodeHovered)
                  : createRingIcon(DESIGN.nodeColor, quantizedOpacity, isNodeHovered);
          
          // Use quantized opacity and hover state in key to force icon update
          const opacityKey = Math.round(quantizedOpacity * 20);
          const hoverKey = isNodeHovered ? 'h' : '';
          
          // Get TX delay recommendation for this node
          const txDelayRec = meshTopology.txDelayRecommendations.get(hash);
          
          return (
            <Marker
              key={`${hash}-${opacityKey}${hoverKey}`}
              position={[neighbor.latitude, neighbor.longitude]}
              icon={icon}
              eventHandlers={{
                mouseover: () => setHoveredMarker(hash),
                mouseout: () => setHoveredMarker(null),
              }}
            >
              <Popup closeButton={false}>
                <NodePopupContent
                  hash={hash}
                  hashPrefix={hashPrefix}
                  name={name}
                  isHub={isHub}
                  isZeroHop={isZeroHop}
                  isMobile={isMobile}
                  isRoomServer={isRoomServer}
                  centrality={centrality}
                  affinity={affinity}
                  meanSnr={meanSnr}
                  neighbor={neighbor}
                  txDelayRec={txDelayRec}
                  onRemove={onRemoveNode ? () => setPendingRemove({ hash, name }) : undefined}
                />
              </Popup>
            </Marker>
          );
        })}
        
        {/* Local node marker - yellow house, rendered LAST to always be on top */}
        {localNode && localNode.latitude && localNode.longitude && (
          <Marker
            key={`local-${hoveredMarker === 'local' ? 'h' : ''}`}
            position={[localNode.latitude, localNode.longitude]}
            icon={createLocalIcon(hoveredMarker === 'local')}
            zIndexOffset={10000}
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
        
        {/* Deep Analysis Modal */}
        <DeepAnalysisModal
          isOpen={showDeepAnalysisModal}
          currentStep={analysisStep}
          packetCount={packetCacheState.packetCount}
          onClose={handleCloseDeepAnalysis}
        />
        
        {/* Map controls - top right */}
        <div className="absolute top-4 right-4 z-[600] flex gap-2">
          {/* Deep Analysis button */}
          <button
            onClick={handleDeepAnalysis}
            disabled={packetCacheState.isDeepLoading || showDeepAnalysisModal}
            className="px-3 py-2 flex items-center gap-2 transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(20, 20, 22, 0.95)',
              borderRadius: '0.75rem',
              border: '1px solid rgba(140, 160, 200, 0.2)',
            }}
            title="Deep Analysis - Load full packet history and rebuild topology"
          >
            <span className="text-xs font-medium text-text-primary">Deep Analysis</span>
            <BarChart2 className="w-4 h-4 text-accent-primary" />
          </button>
          
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
              <ChevronsLeftRightEllipsis className={`w-4 h-4 ${soloDirect ? 'text-indigo-400' : 'text-text-secondary'}`} />
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
            <LegendTooltip text="Green = MeshCore neighbor (direct RF contact). Yellow = hub. All others are rings." />
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
            {/* Local node - house icon */}
            <div className="flex items-center gap-1.5">
              <Home 
                className="w-3 h-3 flex-shrink-0" 
                style={{ color: DESIGN.localColor }}
                strokeWidth={2.5}
              />
              <span className="text-text-muted">Local</span>
            </div>
            {/* Room server indicator - amber chat bubble */}
            {neighborsWithLocation.some(([, n]) => 
              n.contact_type?.toLowerCase() === 'room server' ||
              n.contact_type?.toLowerCase() === 'room_server' || 
              n.contact_type?.toLowerCase() === 'room' || 
              n.contact_type?.toLowerCase() === 'server'
            ) && (
              <div className="flex items-center gap-1.5">
                <MessagesSquare 
                  className="w-3 h-3 flex-shrink-0" 
                  style={{ color: DESIGN.roomServerColor }}
                  strokeWidth={2.5}
                />
                <span className="text-text-muted">Room</span>
              </div>
            )}
            {/* Neighbor indicator - green ring (MeshCore definition: direct RF contact) */}
            {zeroHopNeighbors.size > 0 && (
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-3 h-3 rounded-full flex-shrink-0" 
                  style={{ 
                    background: 'transparent',
                    border: `3px solid ${DESIGN.neighborColor}`,
                    boxSizing: 'border-box',
                  }}
                />
                <span className="text-text-muted">Neighbor</span>
              </div>
            )}
            {/* Mobile node indicator - orange ring */}
            {meshTopology.mobileNodes.length > 0 && (
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-3 h-3 rounded-full flex-shrink-0" 
                  style={{ 
                    background: 'transparent',
                    border: `3px solid ${DESIGN.mobileColor}`,
                    boxSizing: 'border-box',
                  }}
                />
                <span className="text-text-muted">Mobile</span>
              </div>
            )}
          </div>
          
          {/* Neighbor links - always visible, not gated by topology */}
          {zeroHopNeighbors.size > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-white/10">
              <div className="flex items-center gap-1.5">
                <div 
                  className="flex-shrink-0" 
                  style={{ 
                    width: '14px',
                    height: '3px',
                    backgroundColor: DESIGN.edges.neighbor,
                    borderRadius: '1px',
                  }}
                />
                <span className="text-text-muted">Neighbor link</span>
                <LegendTooltip text="Green lines to MeshCore neighbors (direct RF contact with local)." />
              </div>
            </div>
          )}
          
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
                      backgroundColor: DESIGN.edges.standard,
                      borderRadius: '1px',
                    }}
                  />
                  <span className="text-text-muted">Link</span>
                </div>
                {/* Direct path indicator */}
                <div className="flex items-center gap-1.5">
                  <div 
                    className="flex-shrink-0" 
                    style={{ 
                      width: '14px',
                      height: '3px',
                      backgroundColor: DESIGN.edges.direct,
                      borderRadius: '1px',
                    }}
                  />
                  <span className="text-text-muted">Direct</span>
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
                        backgroundColor: DESIGN.edges.loop,
                        borderRadius: '1px',
                      }} />
                      <div style={{ 
                        height: '2px', 
                        backgroundColor: DESIGN.edges.loop,
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
                    <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: DESIGN.edges.loop }} />
                    <div className="flex flex-col">
                      <span style={{ color: DESIGN.edges.loop }} className="font-medium">
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
      
      {/* Liquid glass overlay effects - rendered AFTER map for proper stacking */}
      {!isFullscreen && (
        <div className="absolute inset-0 pointer-events-none rounded-[1.125rem] overflow-hidden">
          {/* Top edge highlight */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          {/* Corner accents */}
          <div className="absolute top-0 left-0 w-24 h-24 bg-gradient-to-br from-white/[0.03] to-transparent" />
          <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-white/[0.03] to-transparent" />
          {/* Bottom edge fade */}
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-black/20 to-transparent" />
        </div>
      )}
    </div>
  );
}
