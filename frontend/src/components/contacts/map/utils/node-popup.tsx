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

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** TX delay recommendation from topology */
export interface TxDelayRec {
  txDelayFactor: number;
  directTxDelayFactor: number;
  trafficIntensity: number;
  directNeighborCount: number;
  collisionRisk: number;
  confidence: number;
  insufficientData?: boolean;
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

/** Node popup content - compact, information-rich */
export function NodePopupContent({
  hash,
  hashPrefix,
  name,
  isHub,
  isZeroHop,
  isMobile,
  isRoomServer,
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
  
  // Build dynamic third metric based on node type
  const thirdMetric = isZeroHop && meanSnr !== undefined 
    ? { label: 'SNR', value: meanSnr.toFixed(1), highlight: false }
    : isHub && centrality > 0 
    ? { label: 'Centrality', value: `${(centrality * 100).toFixed(0)}%`, highlight: true }
    : { label: 'Forwards', value: String(affinity?.directForwardCount || 0), highlight: false };
  
  // Build dynamic fourth metric
  // For zero-hop neighbors, prefer averaged RSSI from direct RF packets over API snapshot
  const fourthMetric = isZeroHop && (meanRssi !== undefined || neighbor.rssi !== undefined)
    ? { label: 'RSSI', value: meanRssi !== undefined ? Math.round(meanRssi).toString() : String(neighbor.rssi), suffix: meanRssi !== undefined ? ' avg' : '' }
    : txDelayRec && !txDelayRec.insufficientData
    ? { label: 'Neighbors', value: String(txDelayRec.directNeighborCount), suffix: '' }
    : { label: 'Forwards', value: String(affinity?.directForwardCount || 0), suffix: '' };
  
  return (
    <div className="min-w-[180px] max-w-[240px] pr-4">
      {/* === HEADER: Name + Remove === */}
      {/* pr-4 above accounts for Leaflet's close button in top-right */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className="text-[14px] font-semibold text-text-primary leading-snug flex-1 min-w-0 truncate">{name}</span>
        {onRemove && (
          <button
            onClick={onRemove}
            className="p-1 -mr-1 text-text-muted/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors flex-shrink-0"
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
          <span className="font-semibold tabular-nums">{fourthMetric.value}{fourthMetric.suffix}</span>
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
