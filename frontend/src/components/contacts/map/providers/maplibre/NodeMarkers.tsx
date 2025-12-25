/**
 * MapLibre NodeMarkers Layer Component
 * 
 * Renders all node markers (neighbors + local) with appropriate icons.
 * Direct port from Leaflet version - maintains exact visual parity.
 * 
 * Features:
 * - Icon types: ring (standard), filled (hub), house (local), chat (room server)
 * - Yellow outer ring for zero-hop neighbors
 * - Opacity animation for solo mode transitions
 * - Popups with detailed node information
 * - Z-index layering via marker ordering (rendered last = on top)
 * 
 * @module providers/maplibre/NodeMarkers
 */

import { useMemo, useCallback, useState } from 'react';
import { Marker, Popup } from 'react-map-gl/maplibre';
import type { NeighborInfo } from '@/types/api';
import type { MeshTopology, LastHopNeighbor } from '@/lib/mesh-topology';
import { DESIGN, MARKER_SIZE, NEIGHBOR_OUTER_RING_SIZE, HIT_AREA_SIZE } from '../../constants';
import { NodePopupContent, type TxDelayRec, type FullAffinity } from '../../utils/node-popup';
import {
  createRingIconHtml,
  createFilledIconHtml,
  createLocalIconHtml,
  createRoomServerIconHtml,
} from './icons';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

export interface NodeMarkersProps {
  /** Neighbors with location data [hash, neighbor][] */
  neighborsWithLocation: [string, NeighborInfo][];
  /** Local node info */
  localNode?: LocalNode;
  /** Local node hash */
  localHash?: string;
  /** Set of zero-hop neighbor hashes */
  zeroHopNeighbors: Set<string>;
  /** Map of last-hop neighbor data (RSSI/SNR) */
  lastHopNeighborMap: Map<string, LastHopNeighbor>;
  /** Mesh topology data */
  meshTopology: MeshTopology;
  /** Currently hovered marker key */
  hoveredMarker: string | null;
  /** Callback when marker hover state changes */
  onMarkerHover: (key: string | null) => void;
  /** Callback to get node opacity (for animation) */
  getNodeOpacity: (hash: string, shouldShow: boolean) => number;
  /** Whether node should be visible based on solo modes */
  shouldShowNode: (hash: string) => boolean;
  /** Callback when remove node is requested */
  onRemoveNode?: (hash: string) => void;
  /** Callback to trigger remove confirmation modal */
  onRequestRemove?: (hash: string, name: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a node is a room server based on contact_type.
 * API returns "Room Server" (with space), handle multiple formats.
 */
function isRoomServerNode(neighbor: NeighborInfo): boolean {
  const type = neighbor.contact_type?.toLowerCase();
  return type === 'room server'
    || type === 'room_server'
    || type === 'room'
    || type === 'server';
}

/**
 * Get compact hash prefix (2 chars).
 */
function getHashPrefix(hash: string): string {
  return hash.startsWith('0x') 
    ? hash.slice(2, 4).toUpperCase() 
    : hash.slice(0, 2).toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Single Marker Component
// ═══════════════════════════════════════════════════════════════════════════════

interface NodeMarkerProps {
  hash: string;
  neighbor: NeighborInfo;
  isZeroHop: boolean;
  isHub: boolean;
  isMobile: boolean;
  isRoomServer: boolean;
  centrality: number;
  lastHopData: LastHopNeighbor | null;
  affinity: FullAffinity | undefined;
  txDelayRec: TxDelayRec | undefined;
  nodeOpacity: number;
  isHovered: boolean;
  onHover: (hash: string | null) => void;
  onRequestRemove?: (hash: string, name: string) => void;
}

function NodeMarker({
  hash,
  neighbor,
  isZeroHop,
  isHub,
  isMobile,
  isRoomServer,
  centrality,
  lastHopData,
  affinity,
  txDelayRec,
  nodeOpacity,
  isHovered,
  onHover,
  onRequestRemove,
}: NodeMarkerProps) {
  const [showPopup, setShowPopup] = useState(false);
  
  const name = neighbor.node_name || neighbor.name || 'Unknown';
  const hashPrefix = getHashPrefix(hash);
  
  // Get RSSI/SNR from lastHopNeighborMap (only for zero-hop neighbors)
  const meanSnr = lastHopData?.avgSnr ?? undefined;
  const meanRssi = lastHopData?.avgRssi ?? undefined;
  
  // Quantize opacity for icon caching (20 steps)
  const quantizedOpacity = Math.round(nodeOpacity * 20) / 20;
  
  // Select icon HTML based on node type priority: Room Server > Hub > Mobile > Standard
  const iconHtml = useMemo(() => {
    if (isRoomServer) {
      return createRoomServerIconHtml(quantizedOpacity, isHovered, isZeroHop);
    }
    if (isHub) {
      return createFilledIconHtml(DESIGN.hubColor, quantizedOpacity, isHovered, isZeroHop);
    }
    if (isMobile) {
      return createRingIconHtml(DESIGN.mobileColor, quantizedOpacity, isHovered, isZeroHop);
    }
    return createRingIconHtml(DESIGN.nodeColor, quantizedOpacity, isHovered, isZeroHop);
  }, [isRoomServer, isHub, isMobile, isZeroHop, quantizedOpacity, isHovered]);
  
  // Calculate marker size for hover area
  const markerSize = isZeroHop ? NEIGHBOR_OUTER_RING_SIZE : MARKER_SIZE;
  
  // Event handlers
  const handleMouseEnter = useCallback(() => onHover(hash), [hash, onHover]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);
  const handleClick = useCallback(() => setShowPopup(true), []);
  
  if (!neighbor.latitude || !neighbor.longitude) return null;
  
  return (
    <>
      <Marker
        longitude={neighbor.longitude}
        latitude={neighbor.latitude}
        anchor="center"
        onClick={handleClick}
      >
        {/* Hit area wrapper - larger invisible area for easier hover/click */}
        <div
          style={{
            width: HIT_AREA_SIZE,
            height: HIT_AREA_SIZE,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* Visual marker content */}
          <div dangerouslySetInnerHTML={{ __html: iconHtml }} />
        </div>
      </Marker>
      
      {showPopup && (
        <Popup
          longitude={neighbor.longitude}
          latitude={neighbor.latitude}
          anchor="bottom"
          offset={[0, -markerSize / 2] as [number, number]}
          closeOnClick={true}
          onClose={() => setShowPopup(false)}
          className="maplibre-popup"
        >
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
            meanRssi={meanRssi}
            neighbor={neighbor}
            txDelayRec={txDelayRec}
            onRemove={onRequestRemove ? () => onRequestRemove(hash, name) : undefined}
          />
        </Popup>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Local Node Marker Component
// ═══════════════════════════════════════════════════════════════════════════════

interface LocalMarkerProps {
  localNode: LocalNode;
  localHash?: string;
  isHovered: boolean;
  onHover: (key: string | null) => void;
}

function LocalMarker({ localNode, localHash, isHovered, onHover }: LocalMarkerProps) {
  const [showPopup, setShowPopup] = useState(false);
  
  const iconHtml = useMemo(() => createLocalIconHtml(isHovered), [isHovered]);
  
  const handleMouseEnter = useCallback(() => onHover('local'), [onHover]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);
  const handleClick = useCallback(() => setShowPopup(true), []);
  
  if (!localNode.latitude || !localNode.longitude) return null;
  
  const markerSize = MARKER_SIZE + 2;
  
  return (
    <>
      <Marker
        longitude={localNode.longitude}
        latitude={localNode.latitude}
        anchor="center"
        onClick={handleClick}
      >
        {/* Hit area wrapper - larger invisible area for easier hover/click */}
        <div
          style={{
            width: HIT_AREA_SIZE,
            height: HIT_AREA_SIZE,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* Visual marker content */}
          <div dangerouslySetInnerHTML={{ __html: iconHtml }} />
        </div>
      </Marker>
      
      {showPopup && (
        <Popup
          longitude={localNode.longitude}
          latitude={localNode.latitude}
          anchor="bottom"
          offset={[0, -markerSize / 2] as [number, number]}
          closeOnClick={true}
          onClose={() => setShowPopup(false)}
          className="maplibre-popup"
        >
          <div className="text-sm">
            <strong className="text-base">{localNode.name}</strong>
            {localHash && (
              <span className="ml-2 font-mono text-xs text-text-muted bg-surface-elevated px-1.5 py-0.5 rounded">
                {getHashPrefix(localHash)}
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
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders all node markers with appropriate styling and popups.
 * 
 * Rendering order (for z-index layering):
 * 1. Standard nodes (rendered first = lowest z-index)
 * 2. Hub nodes
 * 3. Neighbor nodes (zero-hop)
 * 4. Room server nodes
 * 5. Local node (rendered last = highest z-index)
 */
export function NodeMarkers({
  neighborsWithLocation,
  localNode,
  localHash,
  zeroHopNeighbors,
  lastHopNeighborMap,
  meshTopology,
  hoveredMarker,
  onMarkerHover,
  getNodeOpacity,
  shouldShowNode,
  onRequestRemove,
}: NodeMarkersProps) {
  // Sort neighbors by z-index priority (standard < hub < neighbor < room server)
  const sortedNeighbors = useMemo(() => {
    return [...neighborsWithLocation].sort(([hashA, neighborA], [hashB, neighborB]) => {
      const getZIndex = (hash: string, neighbor: NeighborInfo): number => {
        if (isRoomServerNode(neighbor)) return 5000;
        if (zeroHopNeighbors.has(hash)) return 2000;
        if (meshTopology.hubNodes.includes(hash)) return 1000;
        return 0;
      };
      return getZIndex(hashA, neighborA) - getZIndex(hashB, neighborB);
    });
  }, [neighborsWithLocation, zeroHopNeighbors, meshTopology.hubNodes]);
  
  return (
    <>
      {/* ─── NEIGHBOR MARKERS ────────────────────────────────────────────────── */}
      {/* Sorted by z-index: standard → hub → neighbor → room server */}
      {sortedNeighbors.map(([hash, neighbor]) => {
        if (!neighbor.latitude || !neighbor.longitude) return null;
        
        // Visibility and animation
        const shouldShow = shouldShowNode(hash);
        const nodeOpacity = getNodeOpacity(hash, shouldShow);
        
        // Don't render if opacity is effectively 0
        if (nodeOpacity <= 0.01) return null;
        
        // Node type flags
        const isZeroHop = zeroHopNeighbors.has(hash);
        const isHub = meshTopology.hubNodes.includes(hash);
        const isMobile = meshTopology.mobileNodes.includes(hash);
        const isRoomServer = isRoomServerNode(neighbor);
        const centrality = meshTopology.centrality.get(hash) || 0;
        
        // Get RSSI/SNR from lastHopNeighborMap (only for zero-hop neighbors)
        const lastHopData = lastHopNeighborMap.get(hash) ?? null;
        const affinity = meshTopology.fullAffinity.get(hash) as FullAffinity | undefined;
        const txDelayRec = meshTopology.txDelayRecommendations.get(hash) as TxDelayRec | undefined;
        
        return (
          <NodeMarker
            key={hash}
            hash={hash}
            neighbor={neighbor}
            isZeroHop={isZeroHop}
            isHub={isHub}
            isMobile={isMobile}
            isRoomServer={isRoomServer}
            centrality={centrality}
            lastHopData={lastHopData}
            affinity={affinity}
            txDelayRec={txDelayRec}
            nodeOpacity={nodeOpacity}
            isHovered={hoveredMarker === hash}
            onHover={onMarkerHover}
            onRequestRemove={onRequestRemove}
          />
        );
      })}

      {/* ─── LOCAL NODE MARKER ───────────────────────────────────────────────── */}
      {/* Rendered LAST to always be on top */}
      {localNode && localNode.latitude && localNode.longitude && (
        <LocalMarker
          localNode={localNode}
          localHash={localHash}
          isHovered={hoveredMarker === 'local'}
          onHover={onMarkerHover}
        />
      )}
    </>
  );
}
