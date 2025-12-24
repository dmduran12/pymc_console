/**
 * MapControls Overlay Component
 * 
 * Top-right control buttons for map interactions.
 * 
 * Features:
 * - Deep Analysis button (loads full packet history, rebuilds topology)
 * - Topology toggle (show/hide edges)
 * - Solo Hubs toggle (filter to hub connections)
 * - Solo Direct toggle (filter to zero-hop neighbors)
 * - Fullscreen toggle
 * 
 * @module overlays/MapControls
 */

import {
  Maximize2,
  Minimize2,
  Network,
  ChevronsLeftRightEllipsis,
  GitBranch,
  EyeOff,
  BarChart2,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface MapControlsProps {
  /** Whether deep analysis is loading */
  isDeepLoading: boolean;
  /** Whether deep analysis modal is shown */
  showDeepAnalysisModal: boolean;
  /** Callback to trigger deep analysis */
  onDeepAnalysis: () => void;
  /** Whether topology is currently shown */
  showTopology: boolean;
  /** Callback to toggle topology */
  onToggleTopology: () => void;
  /** Whether there are validated polylines to show */
  hasValidatedPolylines: boolean;
  /** Whether solo hubs mode is active */
  soloHubs: boolean;
  /** Callback to toggle solo hubs */
  onToggleSoloHubs: () => void;
  /** Whether there are hub nodes */
  hasHubNodes: boolean;
  /** Whether solo direct mode is active */
  soloDirect: boolean;
  /** Callback to toggle solo direct */
  onToggleSoloDirect: () => void;
  /** Whether there are zero-hop neighbors */
  hasZeroHopNeighbors: boolean;
  /** Whether fullscreen is active */
  isFullscreen: boolean;
  /** Callback to toggle fullscreen */
  onToggleFullscreen: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Styles
// ═══════════════════════════════════════════════════════════════════════════════

const buttonBaseStyle = {
  background: 'rgba(20, 20, 22, 0.95)',
  borderRadius: '0.75rem',
  border: '1px solid rgba(140, 160, 200, 0.2)',
};

const activeButtonStyle = (color: string, borderAlpha: number = 0.4) => ({
  background: color,
  borderRadius: '0.75rem',
  border: `1px solid ${color.replace(/[\d.]+\)$/, `${borderAlpha})`)}`,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map control buttons in the top-right corner.
 */
export function MapControls({
  isDeepLoading,
  showDeepAnalysisModal,
  onDeepAnalysis,
  showTopology,
  onToggleTopology,
  hasValidatedPolylines,
  soloHubs,
  onToggleSoloHubs,
  hasHubNodes,
  soloDirect,
  onToggleSoloDirect,
  hasZeroHopNeighbors,
  isFullscreen,
  onToggleFullscreen,
}: MapControlsProps) {
  return (
    <div className="absolute top-4 right-4 z-[600] flex gap-2">
      {/* ─── DEEP ANALYSIS ───────────────────────────────────────────────────── */}
      <button
        onClick={onDeepAnalysis}
        disabled={isDeepLoading || showDeepAnalysisModal}
        className="px-3 py-2 flex items-center gap-2 transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        style={buttonBaseStyle}
        title="Deep Analysis - Load full packet history and rebuild topology"
      >
        <span className="text-xs font-medium text-text-primary">Deep Analysis</span>
        <BarChart2 className="w-4 h-4 text-accent-primary" />
      </button>
      
      {/* ─── TOPOLOGY TOGGLE ─────────────────────────────────────────────────── */}
      {hasValidatedPolylines && (
        <button
          onClick={onToggleTopology}
          className="p-2 transition-colors hover:bg-white/10"
          style={showTopology 
            ? activeButtonStyle('rgba(74, 222, 128, 0.2)') 
            : buttonBaseStyle
          }
          title={showTopology ? 'Hide topology lines' : 'Show topology lines'}
        >
          {showTopology ? (
            <GitBranch className="w-4 h-4 text-green-400" />
          ) : (
            <EyeOff className="w-4 h-4 text-text-secondary" />
          )}
        </button>
      )}
      
      {/* ─── SOLO HUBS TOGGLE ────────────────────────────────────────────────── */}
      {hasHubNodes && (
        <button
          onClick={onToggleSoloHubs}
          className="p-2 transition-colors hover:bg-white/10"
          style={soloHubs 
            ? { ...buttonBaseStyle, background: 'rgba(251, 191, 36, 0.25)', border: '1px solid rgba(251, 191, 36, 0.5)' }
            : buttonBaseStyle
          }
          title={soloHubs ? 'Show all nodes' : 'Solo hubs & connections'}
        >
          <Network className={`w-4 h-4 ${soloHubs ? 'text-amber-400' : 'text-text-secondary'}`} />
        </button>
      )}
      
      {/* ─── SOLO DIRECT TOGGLE ──────────────────────────────────────────────── */}
      {hasZeroHopNeighbors && (
        <button
          onClick={onToggleSoloDirect}
          className="p-2 transition-colors hover:bg-white/10"
          style={soloDirect 
            ? { ...buttonBaseStyle, background: 'rgba(67, 56, 202, 0.35)', border: '1px solid rgba(67, 56, 202, 0.6)' }
            : buttonBaseStyle
          }
          title={soloDirect ? 'Show all nodes' : 'Solo direct (0-hop) nodes'}
        >
          <ChevronsLeftRightEllipsis className={`w-4 h-4 ${soloDirect ? 'text-indigo-400' : 'text-text-secondary'}`} />
        </button>
      )}
      
      {/* ─── FULLSCREEN TOGGLE ───────────────────────────────────────────────── */}
      <button
        onClick={onToggleFullscreen}
        className="p-2 transition-colors hover:bg-white/10"
        style={buttonBaseStyle}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? (
          <Minimize2 className="w-4 h-4 text-text-secondary" />
        ) : (
          <Maximize2 className="w-4 h-4 text-text-secondary" />
        )}
      </button>
    </div>
  );
}
