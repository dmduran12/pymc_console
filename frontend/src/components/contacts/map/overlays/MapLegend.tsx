/**
 * MapLegend Overlay Component
 * 
 * Bottom-left legend showing node types, edge types, and topology stats.
 * 
 * Features:
 * - Node type indicators (standard, hub, local, room server, mobile, neighbor)
 * - Edge type indicators (standard, neighbor, loop/redundant)
 * - Topology statistics when enabled (nodes, links, hubs, loops)
 * 
 * @module overlays/MapLegend
 */

import { Home, MessagesSquare, RefreshCw } from 'lucide-react';
import type { NeighborInfo } from '@/types/api';
import type { MeshTopology } from '@/lib/mesh-topology';
import { DESIGN } from '../constants';
import { LegendTooltip } from '../utils/node-popup';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface MapLegendProps {
  /** Whether topology is currently shown */
  showTopology: boolean;
  /** Number of validated polylines (links) */
  validatedPolylineCount: number;
  /** Number of filtered neighbors displayed */
  filteredNeighborCount: number;
  /** Whether local node exists */
  hasLocalNode: boolean;
  /** Mesh topology data */
  meshTopology: MeshTopology;
  /** Set of zero-hop neighbor hashes */
  zeroHopNeighbors: Set<string>;
  /** Neighbors with location for checking room servers */
  neighborsWithLocation: [string, NeighborInfo][];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if any neighbor is a room server.
 */
function hasRoomServerNode(neighbors: [string, NeighborInfo][]): boolean {
  return neighbors.some(([, n]) => {
    const type = n.contact_type?.toLowerCase();
    return type === 'room server'
      || type === 'room_server'
      || type === 'room'
      || type === 'server';
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map legend showing node types, edge types, and topology statistics.
 */
export function MapLegend({
  showTopology,
  validatedPolylineCount,
  filteredNeighborCount,
  hasLocalNode,
  meshTopology,
  zeroHopNeighbors,
  neighborsWithLocation,
}: MapLegendProps) {
  return (
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
      {/* ─── NODE TYPES ──────────────────────────────────────────────────────── */}
      <div className="text-text-secondary font-medium mb-1.5 flex items-center gap-1">
        Nodes
        <LegendTooltip text="Node type shown by shape/color. Yellow outer ring = direct RF neighbor." />
      </div>
      
      <div className="flex flex-col gap-1">
        {/* Ring node indicator */}
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
        
        {/* Hub filled indicator */}
        <div className="flex items-center gap-1.5">
          <div 
            className="w-3 h-3 rounded-full flex-shrink-0" 
            style={{ backgroundColor: DESIGN.hubColor }}
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
        
        {/* Room server indicator */}
        {hasRoomServerNode(neighborsWithLocation) && (
          <div className="flex items-center gap-1.5">
            <MessagesSquare 
              className="w-3 h-3 flex-shrink-0" 
              style={{ color: DESIGN.roomServerColor }}
              strokeWidth={2.5}
            />
            <span className="text-text-muted">Room</span>
          </div>
        )}
        
        {/* Mobile node indicator */}
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
        
        {/* Neighbor indicator - yellow outer ring */}
        {zeroHopNeighbors.size > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="relative w-4 h-4 flex-shrink-0">
              {/* Outer yellow ring */}
              <div 
                className="absolute inset-0 rounded-full"
                style={{ 
                  background: 'transparent',
                  border: `1px solid ${DESIGN.neighborColor}`,
                  boxSizing: 'border-box',
                  opacity: 0.8,
                }}
              />
              {/* Inner node indicator */}
              <div 
                className="absolute rounded-full"
                style={{ 
                  top: '4px',
                  left: '4px',
                  width: '8px',
                  height: '8px',
                  background: 'transparent',
                  border: `2px solid ${DESIGN.nodeColor}`,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <span className="text-text-muted">Neighbor</span>
          </div>
        )}
      </div>
      
      {/* ─── NEIGHBOR LINKS ──────────────────────────────────────────────────── */}
      {zeroHopNeighbors.size > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-white/10">
          <div className="flex items-center gap-1.5">
            <div 
              className="flex-shrink-0" 
              style={{ 
                width: '14px',
                height: '2px',
                backgroundImage: `repeating-linear-gradient(90deg, ${DESIGN.edges.neighborRest} 0, ${DESIGN.edges.neighborRest} 3px, transparent 3px, transparent 5px)`,
                borderRadius: '1px',
              }}
            />
            <span className="text-text-muted">Neighbor</span>
            <LegendTooltip text="Dashed gray → yellow on hover. Direct RF contact with local." />
          </div>
        </div>
      )}
      
      {/* ─── TOPOLOGY STATS ──────────────────────────────────────────────────── */}
      {showTopology && validatedPolylineCount > 0 && (
        <>
          <div className="text-text-secondary font-medium mt-2 pt-2 border-t border-white/10 mb-1 flex items-center gap-1">
            Topology
            <LegendTooltip text="Links with 5+ validations. Thickness = relative strength." />
          </div>
          
          <div className="flex flex-col gap-0.5 text-text-muted">
            <div className="flex justify-between tabular-nums">
              <span>Nodes</span>
              <span className="text-text-secondary">{filteredNeighborCount + (hasLocalNode ? 1 : 0)}</span>
            </div>
            <div className="flex justify-between tabular-nums">
              <span>Links</span>
              <span className="text-text-secondary">{validatedPolylineCount}</span>
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
                  backgroundColor: DESIGN.edges.rest,
                  borderRadius: '1px',
                }}
              />
              <span className="text-text-muted">Link</span>
              <LegendTooltip text="Gray at rest. Hover to reveal type (teal=direct, indigo=loop)." />
            </div>
            
            {/* Loop/redundant path indicator */}
            {meshTopology.loops.length > 0 && (
              <div className="flex items-center gap-1.5">
                <div className="flex-shrink-0 flex flex-col gap-0.5" style={{ width: '14px' }}>
                  <div style={{ 
                    height: '2px', 
                    backgroundColor: DESIGN.edges.rest,
                    borderRadius: '1px',
                  }} />
                  <div style={{ 
                    height: '2px', 
                    backgroundColor: DESIGN.edges.rest,
                    borderRadius: '1px',
                  }} />
                </div>
                <span className="text-text-muted">Redundant</span>
              </div>
            )}
          </div>
          
          {/* Loops indicator */}
          {meshTopology.loops.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-white/10">
              <div className="flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: DESIGN.edges.hoverLoop }} />
                <div className="flex flex-col">
                  <span style={{ color: DESIGN.edges.hoverLoop }} className="font-medium">
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
  );
}
