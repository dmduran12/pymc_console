/**
 * Map Design System Constants
 * 
 * Centralized design tokens for the ContactsMap component.
 * Extracted to enable easy theming and MapLibre migration.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Marker Dimensions
// ═══════════════════════════════════════════════════════════════════════════════

/** Uniform marker size for all nodes (outer dimension in pixels) */
export const MARKER_SIZE = 14;

/** Ring thickness for torus/ring markers */
export const RING_THICKNESS = 5;

/** Outer ring size for neighbor indicator (larger than marker for glow effect) */
export const NEIGHBOR_OUTER_RING_SIZE = 20;

/** Neighbor ring thickness (subtle 1px outer ring) */
export const NEIGHBOR_RING_THICKNESS = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// Color Palette
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Design palette - sophisticated, minimal, low contrast against dark map.
 * 
 * Philosophy:
 * - At rest: unified gray edges, subtle node differentiation
 * - On hover: colors reveal semantic meaning (type, quality, etc.)
 */
export const DESIGN = {
  // ─── NODE COLORS ─────────────────────────────────────────────────────────────
  
  /** Primary node color - deep royal blue-purple, dark and subtle */
  nodeColor: '#4338CA',        // Deep indigo/royal blue
  
  /** Local node - warm golden yellow (home icon) */
  localColor: '#FBBF24',       // Amber-400
  
  /** Hub indicator - 25% brighter, saturated royal blue-purple */
  hubColor: '#6366F1',         // Indigo-500 (brighter, still saturated)
  
  /** Mobile node indicator - warm orange (stands out from purple/blue) */
  mobileColor: '#F97316',      // Orange-500 - indicates volatile/mobile node
  
  /** Room server indicator - amber/gold (chat/server functionality) */
  roomServerColor: '#F59E0B',  // Amber-500 - indicates room server node
  
  /** Zero-hop neighbor - yellow (matches home icon semantic: "connected to home") */
  neighborColor: '#FBBF24',    // Amber-400 - same as localColor
  
  // ─── EDGE COLOR SYSTEM ─────────────────────────────────────────────────────────
  // At rest: All edges are gray (calm, unified look)
  // On hover: Color reveals edge type
  
  edges: {
    /** Rest state - unified gray for all edges */
    rest: '#4B5563',           // Gray-600 - calm baseline
    restBright: '#6B7280',     // Gray-500 - for backbone emphasis
    restDim: '#374151',        // Gray-700 - for weak/uncertain
    
    /** Hover state - colors reveal edge type */
    hoverDirect: '#5EEAD4',    // Teal-300 - direct path edges
    hoverLoop: '#6366F1',      // Indigo-500 - loop/redundant edges
    hoverStandard: '#9CA3AF',  // Gray-400 - standard edges brighten
    hoverNeighbor: '#FBBF24',  // Amber-400 - yellow neighbor edges (matches home icon)
    
    /** Neighbor edges (always visible as dashed) - rest vs hover */
    neighborRest: '#6B7280',   // Gray-500 - subtle dashed gray
    neighborHover: '#FBBF24',  // Amber-400 - yellow on hover (matches home icon)
  },
  
  /** Base opacity for edges (increased from 0.7 for better visibility) */
  edgeOpacity: 0.82,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Animation Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Edge trace animation duration in milliseconds */
export const EDGE_ANIMATION_DURATION = 2000;

/** Edge exit (retract) animation duration in milliseconds */
export const EDGE_EXIT_DURATION = 500;

/** Node fade animation duration in milliseconds */
export const NODE_FADE_DURATION = 500;

/** Maximum stagger delay for node animations in milliseconds */
export const MAX_NODE_STAGGER_DELAY = 250;

/** Minimum time to show "Building Topology" step in milliseconds */
export const MIN_BUILDING_TIME_MS = 1700;

/** Time to show "Ready!" state before closing modal in milliseconds */
export const READY_DISPLAY_TIME_MS = 1000;

/** Delay after modal closes before starting edge animation in milliseconds */
export const POST_MODAL_ANIMATION_DELAY_MS = 150;

// ═══════════════════════════════════════════════════════════════════════════════
// Icon Cache Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum number of icons to cache (FIFO eviction when exceeded) */
export const ICON_CACHE_MAX_SIZE = 200;

// ═══════════════════════════════════════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════════════════════════════════════

export type DesignPalette = typeof DESIGN;
export type EdgeColors = typeof DESIGN.edges;
