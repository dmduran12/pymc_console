/**
 * NeighborEdges Layer Component
 * 
 * Renders dashed lines from local node to zero-hop (direct RF) neighbors.
 * These are ALWAYS visible - not gated by topology toggle.
 * 
 * Features:
 * - Dashed gray lines at rest, yellow on hover (matches home icon semantic)
 * - Tooltips with RSSI/SNR data from direct RF packets
 * - Signal quality data from lastHopNeighbors (topology-computed averages)
 * 
 * @module layers/NeighborEdges
 */

import { Polyline, Tooltip } from 'react-leaflet';
import type { NeighborInfo } from '@/types/api';
import type { LastHopNeighbor } from '@/lib/mesh-topology';
import { DESIGN } from '../constants';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface NeighborPolylineData {
  from: [number, number];
  to: [number, number];
  hash: string;
  neighbor: NeighborInfo;
  lastHopData: LastHopNeighbor | null;
}

export interface NeighborEdgesProps {
  /** Neighbor polylines to render */
  neighborPolylines: NeighborPolylineData[];
  /** Currently hovered edge key */
  hoveredEdgeKey: string | null;
  /** Callback when edge hover state changes */
  onEdgeHover: (key: string | null) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders neighbor edges as dashed lines from local to zero-hop neighbors.
 * Always visible regardless of topology toggle state.
 */
export function NeighborEdges({
  neighborPolylines,
  hoveredEdgeKey,
  onEdgeHover,
}: NeighborEdgesProps) {
  return (
    <>
      {neighborPolylines.map(({ from, to, hash, neighbor, lastHopData }) => {
        const name = neighbor.node_name || neighbor.name || hash.slice(0, 8);
        
        // Prefer topology-computed RSSI/SNR (averaged from actual packets) over API snapshot
        const snr = lastHopData?.avgSnr ?? neighbor.snr;
        const rssi = lastHopData?.avgRssi ?? neighbor.rssi;
        const packetCount = lastHopData?.count;
        const confidence = lastHopData?.confidence;
        
        // Hover state: gray at rest, yellow on hover (matches home icon semantic)
        const neighborEdgeKey = `neighbor-${hash}`;
        const isNeighborHovered = hoveredEdgeKey === neighborEdgeKey;
        const neighborColor = isNeighborHovered ? DESIGN.edges.neighborHover : DESIGN.edges.neighborRest;
        const neighborWeight = isNeighborHovered ? 2.5 : 1.5;
        const neighborOpacity = isNeighborHovered ? 1 : 0.6;
        
        return (
          <Polyline
            key={`neighbor-edge-${hash}`}
            positions={[from, to]}
            pathOptions={{
              color: neighborColor,
              weight: neighborWeight,
              opacity: neighborOpacity,
              dashArray: '4, 4',
              lineCap: 'round',
              lineJoin: 'round',
            }}
            eventHandlers={{
              mouseover: () => onEdgeHover(neighborEdgeKey),
              mouseout: () => onEdgeHover(null),
            }}
          >
            <Tooltip permanent={false} direction="auto" className="topology-edge-tooltip">
              <NeighborTooltipContent
                name={name}
                prefix={lastHopData?.prefix}
                rssi={rssi}
                snr={snr}
                packetCount={packetCount}
                confidence={confidence}
                hasAvgRssi={lastHopData?.avgRssi !== undefined}
                hasAvgSnr={lastHopData?.avgSnr !== undefined}
              />
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tooltip Content Component
// ═══════════════════════════════════════════════════════════════════════════════

interface NeighborTooltipContentProps {
  name: string;
  prefix?: string;
  rssi?: number | null;
  snr?: number | null;
  packetCount?: number;
  confidence?: number;
  hasAvgRssi: boolean;
  hasAvgSnr: boolean;
}

/**
 * Tooltip content for neighbor edges.
 * Shows signal quality metrics and packet count.
 */
function NeighborTooltipContent({
  name,
  prefix,
  rssi,
  snr,
  packetCount,
  confidence,
  hasAvgRssi,
  hasAvgSnr,
}: NeighborTooltipContentProps) {
  return (
    <div className="text-xs">
      <div className="font-medium text-text-primary">
        <span className="text-amber-400">●</span> {name}
        {prefix && (
          <span className="ml-1 text-text-muted font-mono text-[10px]">
            ({prefix})
          </span>
        )}
      </div>
      
      <div className="text-text-secondary flex gap-2">
        {rssi !== undefined && rssi !== null && (
          <span>RSSI: {Math.round(rssi)} dBm{hasAvgRssi && ' avg'}</span>
        )}
        {snr !== undefined && snr !== null && (
          <span>SNR: {snr.toFixed(1)} dB{hasAvgSnr && ' avg'}</span>
        )}
      </div>
      
      {packetCount !== undefined && (
        <div className="text-text-muted text-[10px]">
          {packetCount.toLocaleString()} packets
          {confidence !== undefined && ` • ${Math.round(confidence * 100)}% conf`}
        </div>
      )}
      
      <div className="text-amber-400 text-[10px] mt-0.5">Direct RF neighbor</div>
    </div>
  );
}
