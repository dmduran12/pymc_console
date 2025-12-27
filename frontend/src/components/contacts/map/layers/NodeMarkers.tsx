/**
 * NodeMarkers Layer Component
 * 
 * Renders all node markers (neighbors + local) with appropriate icons.
 * 
 * Features:
 * - Icon types: ring (standard), filled (hub), house (local), chat (room server)
 * - Yellow outer ring for zero-hop neighbors
 * - Opacity animation for solo mode transitions
 * - Popups with detailed node information
 * - Z-index layering (standard < hub < neighbor < room server < local)
 * 
 * @module layers/NodeMarkers
 */

import { Marker, Popup } from 'react-leaflet';
import type { NeighborInfo } from '@/types/api';
import type { MeshTopology, LastHopNeighbor } from '@/lib/mesh-topology';
import { DESIGN } from '../constants';
import {
  createRingIcon,
  createFilledIcon,
  createLocalIcon,
  createRoomServerIcon,
} from '../icons';
import { NodePopupContent, type TxDelayRec, type FullAffinity } from '../utils/node-popup';

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
// Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders all node markers with appropriate styling and popups.
 * Local node is rendered last to ensure it's always on top.
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
  return (
    <>
      {/* ─── NEIGHBOR MARKERS ────────────────────────────────────────────────── */}
      {neighborsWithLocation.map(([hash, neighbor]) => {
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
        const lastHopData = lastHopNeighborMap.get(hash);
        const meanSnr = lastHopData?.avgSnr ?? undefined;
        const meanRssi = lastHopData?.avgRssi ?? undefined;
        const isStale = lastHopData?.status === 'stale';
        const lastSeenTimestamp = lastHopData?.lastSeen ?? undefined;
        
        const name = neighbor.node_name || neighbor.name || 'Unknown';
        const hashPrefix = getHashPrefix(hash);
        const affinity = meshTopology.fullAffinity.get(hash) as FullAffinity | undefined;
        const txDelayRec = meshTopology.txDelayRecommendations.get(hash) as TxDelayRec | undefined;
        
        // Quantize opacity for icon caching (20 steps)
        const quantizedOpacity = Math.round(nodeOpacity * 20) / 20;
        const isNodeHovered = hoveredMarker === hash;
        
        // Select icon based on node type priority: Room Server > Hub > Mobile > Standard
        const icon = isRoomServer
          ? createRoomServerIcon(quantizedOpacity, isNodeHovered, isZeroHop)
          : isHub 
            ? createFilledIcon(DESIGN.hubColor, quantizedOpacity, isNodeHovered, isZeroHop)
            : isMobile
              ? createRingIcon(DESIGN.mobileColor, quantizedOpacity, isNodeHovered, isZeroHop)
              : createRingIcon(DESIGN.nodeColor, quantizedOpacity, isNodeHovered, isZeroHop);
        
        // Z-index layering (lower to higher):
        // Standard: 0, Hub: 1000, Neighbor: 2000, Room Server: 5000, Local: 10000
        const zIndex = isRoomServer ? 5000 
          : isZeroHop ? 2000 
          : isHub ? 1000 
          : 0;
        
        // Key includes opacity and hover state to force icon update
        const opacityKey = Math.round(quantizedOpacity * 20);
        const hoverKey = isNodeHovered ? 'h' : '';
        
        return (
          <Marker
            key={`${hash}-${opacityKey}${hoverKey}`}
            position={[neighbor.latitude, neighbor.longitude]}
            icon={icon}
            zIndexOffset={zIndex}
            eventHandlers={{
              mouseover: () => onMarkerHover(hash),
              mouseout: () => onMarkerHover(null),
            }}
          >
            <Popup 
              closeButton={true}
              autoClose={true}
              closeOnClick={false}
              closeOnEscapeKey={true}
            >
              <NodePopupContent
                hash={hash}
                hashPrefix={hashPrefix}
                name={name}
                isHub={isHub}
                isZeroHop={isZeroHop}
                isMobile={isMobile}
                isRoomServer={isRoomServer}
                isStale={isStale}
                lastSeenTimestamp={lastSeenTimestamp}
                centrality={centrality}
                affinity={affinity}
                meanSnr={meanSnr}
                meanRssi={meanRssi}
                neighbor={neighbor}
                txDelayRec={txDelayRec}
                onRemove={onRequestRemove ? () => onRequestRemove(hash, name) : undefined}
              />
            </Popup>
          </Marker>
        );
      })}

      {/* ─── LOCAL NODE MARKER ───────────────────────────────────────────────── */}
      {/* Rendered LAST to always be on top */}
      {localNode && localNode.latitude && localNode.longitude && (
        <Marker
          key={`local-${hoveredMarker === 'local' ? 'h' : ''}`}
          position={[localNode.latitude, localNode.longitude]}
          icon={createLocalIcon(hoveredMarker === 'local')}
          zIndexOffset={10000}
          eventHandlers={{
            mouseover: () => onMarkerHover('local'),
            mouseout: () => onMarkerHover(null),
          }}
        >
          <Popup
            closeButton={true}
            autoClose={true}
            closeOnClick={false}
            closeOnEscapeKey={true}
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
        </Marker>
      )}
    </>
  );
}
