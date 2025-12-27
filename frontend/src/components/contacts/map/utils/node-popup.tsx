/**
 * Node Popup Components
 * 
 * Popup content for node markers and helper tooltip for legend.
 */

import { useState } from 'react';
import { Copy, Check, Trash2, Info } from 'lucide-react';
import type { NeighborInfo } from '@/types/api';
import { formatRelativeTime } from '@/lib/format';
import { DESIGN } from '../constants';
import { NodeSparkline } from '../../NodeSparkline';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** TX delay recommendation from topology (MeshCore slot-aligned) */
export interface TxDelayRec {
  // New MeshCore-aligned fields
  floodDelaySec?: number;
  directDelaySec?: number;
  floodSlots?: number;
  directSlots?: number;
  networkRole?: 'edge' | 'relay' | 'hub' | 'backbone';
  rationale?: string;
  // Legacy fields (backward compat)
  txDelayFactor: number;
  directTxDelayFactor: number;
  trafficIntensity: number;
  directNeighborCount: number;
  collisionRisk: number;
  confidence: number;
  insufficientData?: boolean;
  // Observer bias correction fields
  observationSymmetry?: number;
  dataConfidence?: 'insufficient' | 'low' | 'medium' | 'high';
}

/** Full affinity data from topology */
export interface FullAffinity {
  frequency: number;
  directForwardCount: number;
  typicalHopPosition: number;
  distanceMeters: number | null;
  hopPositionCounts: number[];
}

export interface NodePopupContentProps {
  hash: string;
  hashPrefix: string;
  name: string;
  isHub: boolean;
  isZeroHop: boolean;
  isMobile: boolean;
  isRoomServer: boolean;
  isStale: boolean;
  lastSeenTimestamp?: number;
  centrality: number;
  affinity?: FullAffinity;
  meanSnr?: number;
  meanRssi?: number;
  neighbor: NeighborInfo;
  onRemove?: () => void;
  txDelayRec?: TxDelayRec;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Format distance for display */
function formatDistance(meters: number | null): string {
  if (meters === null) return '—';
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════════════════════

/** Simple tooltip for legend items - no blur for performance */
export function LegendTooltip({ text }: { text: string }) {
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

/** 
 * Node popup content - 12-column grid layout
 * 
 * Layout structure (conceptual 12-col grid mapped to actual widths):
 * Row 1: Name (12 cols)
 * Row 2: Hash + Badges (12 cols, flex wrap)
 * Row 3: Meta info (12 cols) 
 * Row 4: Sparkline (12 cols, full width with tooltip)
 * Row 5: Metrics grid (6+6 cols = 2 columns)
 * Row 6: Footer - TX recs + Remove (split 8+4)
 */
/** Format date as MM/DD for stale indicator */
function formatLastHeardDate(timestamp: number): string {
  const date = new Date(timestamp * 1000); // Convert from Unix seconds
  return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
}

export function NodePopupContent({
  hash,
  hashPrefix,
  name,
  isHub,
  isZeroHop,
  isMobile,
  isRoomServer,
  isStale,
  lastSeenTimestamp,
  centrality,
  affinity,
  meanSnr,
  meanRssi,
  neighbor,
  onRemove,
  txDelayRec,
}: NodePopupContentProps) {
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
  
  // Build metrics array for clean rendering
  type Metric = { label: string; value: string | number; highlight?: boolean };
  const metrics: Metric[] = [
    { label: 'Packets', value: affinity?.frequency || 0 },
    { label: 'Adverts', value: neighbor.advert_count || 0 },
  ];
  
  // Add SNR/RSSI for direct neighbors, or centrality for hubs
  if (isZeroHop && meanSnr !== undefined) {
    metrics.push({ label: 'SNR', value: `${meanSnr.toFixed(1)} dB` });
  } else if (isHub && centrality > 0) {
    metrics.push({ label: 'Centrality', value: `${(centrality * 100).toFixed(0)}%`, highlight: true });
  }
  
  if (isZeroHop && meanRssi !== undefined) {
    metrics.push({ label: 'RSSI', value: `${Math.round(meanRssi)} dBm` });
  }
  
  const hasTxRecs = txDelayRec && !txDelayRec.insufficientData;
  
  return (
    <div className="w-[220px] pr-3">
      {/* ═══ ROW 1: Name (full width) ═══ */}
      <div className="text-[14px] font-semibold text-text-primary leading-snug truncate mb-0.5">
        {name}
      </div>
      
      {/* ═══ ROW 2: Hash + Badges (flex wrap) ═══ */}
      <div className="flex items-center gap-1 flex-wrap mb-1.5">
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
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-orange-500/25 text-orange-300">Mobile</span>
        )}
        {neighbor.is_repeater && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-cyan-500/20 text-cyan-400">Rptr</span>
        )}
        {isRoomServer && (
          <span className="px-1 py-px text-[8px] font-bold uppercase rounded bg-amber-500/25 text-amber-400">Room</span>
        )}
        {isStale && lastSeenTimestamp && (
          <span 
            className="px-1 py-px text-[8px] font-medium rounded bg-gray-500/30 text-gray-300"
            title="Neighbor not heard in 7+ days"
          >
            Idle {formatLastHeardDate(lastSeenTimestamp)}
          </span>
        )}
      </div>
      
      {/* ═══ ROW 3: Meta - Time · Distance · Coords ═══ */}
      <div className="text-[10px] text-text-muted/60 mb-2 leading-tight">
        <span>{formatRelativeTime(neighbor.last_seen)}</span>
        {affinity?.distanceMeters && (
          <span className="font-medium text-text-muted/80"> · {formatDistance(affinity.distanceMeters)}</span>
        )}
        {neighbor.latitude && neighbor.longitude && neighbor.latitude !== 0 && neighbor.longitude !== 0 && (
          <span className="font-mono text-[9px]"> · {neighbor.latitude.toFixed(4)}, {neighbor.longitude.toFixed(4)}</span>
        )}
      </div>
      
      {/* ═══ ROW 4: Sparkline (full width, interactive) ═══ */}
      <div className="mb-2">
        <NodeSparkline 
          nodeHash={hash} 
          width="100%" 
          height={28} 
          showArea={true}
          showTooltip={true}
        />
      </div>
      
      {/* ═══ ROW 5: Metrics (2-column grid) ═══ */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] mb-2">
        {metrics.map((m, i) => (
          <div key={i} className="flex justify-between">
            <span className="text-text-muted/50">{m.label}</span>
            <span className={`font-semibold tabular-nums ${'highlight' in m && m.highlight ? 'text-amber-400' : ''}`}>
              {m.value}
            </span>
          </div>
        ))}
      </div>
      
      {/* ═══ ROW 6: Footer - TX Recs (left) + Remove (right) ═══ */}
      {(hasTxRecs || onRemove) && (
        <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/5">
          {/* TX Recommendations - MeshCore slot-aligned */}
          {hasTxRecs ? (
            <div className="flex flex-col gap-0.5 text-[10px] text-text-muted/60">
              <div className="flex items-center gap-1.5">
                <span className="uppercase text-[8px] font-semibold tracking-wide text-text-muted/40">TX</span>
                {/* Show slot counts if available, otherwise fall back to legacy values */}
                {txDelayRec.floodSlots !== undefined ? (
                  <>
                    <span>
                      F <span className={`font-semibold tabular-nums ${
                        txDelayRec.dataConfidence === 'low' ? 'text-amber-400/50' : 'text-amber-400'
                      }`}>
                        {txDelayRec.floodDelaySec?.toFixed(1)}s
                      </span>
                      <span className="text-text-muted/40"> ({txDelayRec.floodSlots})</span>
                    </span>
                    <span>
                      D <span className={`font-semibold tabular-nums ${
                        txDelayRec.dataConfidence === 'low' ? 'text-amber-400/50' : 'text-amber-400'
                      }`}>
                        {txDelayRec.directDelaySec?.toFixed(1)}s
                      </span>
                      <span className="text-text-muted/40"> ({txDelayRec.directSlots})</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span>F <span className="font-semibold text-amber-400 tabular-nums">{txDelayRec.txDelayFactor.toFixed(2)}</span></span>
                    <span>D <span className="font-semibold text-amber-400 tabular-nums">{txDelayRec.directTxDelayFactor.toFixed(2)}</span></span>
                  </>
                )}
                {/* Data confidence indicator */}
                {txDelayRec.dataConfidence === 'low' && (
                  <span className="text-[9px] text-amber-500" title="Low confidence - limited data or asymmetric traffic">⚠️</span>
                )}
                {txDelayRec.dataConfidence === 'high' && (
                  <span className="text-[9px] text-green-400" title="High confidence - good bidirectional visibility">✓</span>
                )}
              </div>
              {/* Show network role and symmetry info */}
              <div className="flex items-center gap-1">
                {txDelayRec.networkRole && (
                  <span className="text-[9px] text-text-muted/40 capitalize">
                    {txDelayRec.networkRole}
                  </span>
                )}
                {txDelayRec.observationSymmetry !== undefined && (
                  <span className={`text-[9px] ${
                    txDelayRec.observationSymmetry >= 0.5 
                      ? 'text-green-400/60' 
                      : txDelayRec.observationSymmetry < 0.3 
                        ? 'text-amber-500/60' 
                        : 'text-text-muted/40'
                  }`} title={`Edge symmetry: ${Math.round(txDelayRec.observationSymmetry * 100)}% bidirectional`}>
                    {txDelayRec.observationSymmetry >= 0.5 ? '↔' : txDelayRec.observationSymmetry < 0.3 ? '→' : '⇄'}
                    {Math.round(txDelayRec.observationSymmetry * 100)}%
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div /> /* Spacer */
          )}
          
          {/* Remove button */}
          {onRemove && (
            <button
              onClick={onRemove}
              className="flex items-center gap-0.5 p-1 text-[10px] text-text-muted/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
              title="Remove from contacts"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
