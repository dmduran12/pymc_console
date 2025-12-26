/**
 * Sparkline Store
 * 
 * Zustand store for sparkline data computed by the Web Worker.
 * Provides reactive access to sparkline data for UI components.
 */

import { create } from 'zustand';
import { sparklineService, type SparklineDataPoint } from '@/lib/sparkline-service';

// Re-export types for consumers
export type { SparklineDataPoint };

interface SparklineState {
  // Sparkline data by node hash
  sparklines: Map<string, SparklineDataPoint[]>;
  
  // Computation state
  isComputing: boolean;
  
  // Metadata
  lastUpdated: number;
  nodeCount: number;
  
  // Actions
  setSparklines: (sparklines: Map<string, SparklineDataPoint[]>) => void;
  setComputing: (isComputing: boolean) => void;
}

const useSparklineStoreBase = create<SparklineState>((set) => ({
  sparklines: new Map(),
  isComputing: false,
  lastUpdated: 0,
  nodeCount: 0,
  
  setSparklines: (sparklines) => set({
    sparklines,
    lastUpdated: Date.now(),
    nodeCount: sparklines.size,
    isComputing: false,
  }),
  
  setComputing: (isComputing) => set({ isComputing }),
}));

// Subscribe to sparkline service updates
// This connects the worker results to the Zustand store
// Deferred to avoid immediate notification during module initialization
if (typeof window !== 'undefined') {
  // Use setTimeout to defer subscription until after initial React render
  // This prevents the immediate notification from causing render issues
  setTimeout(() => {
    sparklineService.subscribe((sparklines, isComputing) => {
      const state = useSparklineStoreBase.getState();
      
      // Batch state updates to avoid multiple re-renders
      if (isComputing && !state.isComputing) {
        state.setComputing(true);
      } else if (!isComputing && sparklines.size > 0) {
        state.setSparklines(sparklines);
      } else if (!isComputing && state.isComputing) {
        state.setComputing(false);
      }
    });
  }, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Selectors - granular access to prevent unnecessary re-renders
// ═══════════════════════════════════════════════════════════════════════════════

/** Full store access (use sparingly) */
export const useSparklineStore = useSparklineStoreBase;

/** All sparklines Map */
export const useAllSparklines = () => useSparklineStoreBase((s) => s.sparklines);

/** Whether worker is currently computing */
export const useIsComputingSparklines = () => useSparklineStoreBase((s) => s.isComputing);

/** Total number of computed sparklines */
export const useSparklineCount = () => useSparklineStoreBase((s) => s.nodeCount);

/** Timestamp of last update */
export const useSparklineLastUpdated = () => useSparklineStoreBase((s) => s.lastUpdated);

/** Has any sparkline data */
export const useHasSparklines = () => useSparklineStoreBase((s) => s.sparklines.size > 0);

// ═══════════════════════════════════════════════════════════════════════════════
// Per-node selector (memoized via Zustand's equality check)
// ═══════════════════════════════════════════════════════════════════════════════

// Stable empty array reference to avoid new references on every call
const EMPTY_SPARKLINE: SparklineDataPoint[] = [];

// Cache for individual sparkline selectors to maintain referential stability
const sparklineSelectors = new Map<string, SparklineDataPoint[]>();

/**
 * Get sparkline data for a specific node.
 * Returns empty array if not yet computed.
 * 
 * Note: This uses a cached selector pattern to avoid creating new array
 * references on every render, which would cause unnecessary re-renders.
 */
export function useSparkline(nodeHash: string): SparklineDataPoint[] {
  return useSparklineStoreBase((s) => {
    const data = s.sparklines.get(nodeHash);
    
    if (!data || data.length === 0) {
      // Return stable empty array reference (CRITICAL: must be same reference!)
      return EMPTY_SPARKLINE;
    }
    
    // Check if we have a cached version with same reference
    const cached = sparklineSelectors.get(nodeHash);
    if (cached === data) {
      return cached;
    }
    
    // Update cache and return
    sparklineSelectors.set(nodeHash, data);
    return data;
  });
}

/**
 * Check if a specific node's sparkline is ready.
 */
export function useIsSparklineReady(nodeHash: string): boolean {
  return useSparklineStoreBase((s) => {
    const data = s.sparklines.get(nodeHash);
    return data !== undefined && data.length > 0;
  });
}
