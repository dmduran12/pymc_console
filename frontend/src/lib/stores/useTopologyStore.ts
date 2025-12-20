/**
 * Topology Store
 * 
 * Zustand store for mesh topology data computed by the Web Worker.
 * Provides reactive access to topology edges, hub nodes, and centrality.
 */

import { create } from 'zustand';
import { topologyService, type MeshTopology, type NeighborAffinity, type TopologyEdge, type NetworkLoop, type TxDelayRecommendation } from '@/lib/topology-service';

// Re-export types for consumers
export type { MeshTopology, NeighborAffinity, TopologyEdge, NetworkLoop, TxDelayRecommendation };

interface TopologyState {
  // Topology data
  topology: MeshTopology;
  
  // Metadata
  isComputing: boolean;
  lastComputeTimeMs: number;
  lastUpdated: number;
  
  // Actions
  setTopology: (topology: MeshTopology, computeTimeMs: number) => void;
  setComputing: (isComputing: boolean) => void;
}

/** Create empty topology for initial state */
function createEmptyTopology(): MeshTopology {
  return {
    edges: [],
    validatedEdges: [],
    certainEdges: [],
    uncertainEdges: [],
    edgeMap: new Map(),
    maxPacketCount: 0,
    maxCertainCount: 0,
    neighborAffinity: new Map(),
    fullAffinity: new Map(),
    localPrefix: null,
    centrality: new Map(),
    hubNodes: [],
    loops: [],
    loopEdgeKeys: new Set(),
    txDelayRecommendations: new Map(),
  };
}

const useTopologyStoreBase = create<TopologyState>((set) => ({
  topology: createEmptyTopology(),
  isComputing: false,
  lastComputeTimeMs: 0,
  lastUpdated: 0,
  
  setTopology: (topology, computeTimeMs) => set({
    topology,
    lastComputeTimeMs: computeTimeMs,
    lastUpdated: Date.now(),
    isComputing: false,
  }),
  
  setComputing: (isComputing) => set({ isComputing }),
}));

// Subscribe to topology service updates
// This connects the worker results to the Zustand store
if (typeof window !== 'undefined') {
  topologyService.subscribe((topology, computeTimeMs) => {
    useTopologyStoreBase.getState().setTopology(topology, computeTimeMs);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Selectors - granular access to prevent unnecessary re-renders
// ═══════════════════════════════════════════════════════════════════════════

/** Full store access (use sparingly) */
export const useTopologyStore = useTopologyStoreBase;

/** Full topology object */
export const useTopology = () => useTopologyStoreBase((s) => s.topology);

/** Validated edges (for rendering) */
export const useValidatedEdges = () => useTopologyStoreBase((s) => s.topology.validatedEdges);

/** All edges (including unvalidated) */
export const useAllEdges = () => useTopologyStoreBase((s) => s.topology.edges);

/** Hub node hashes */
export const useHubNodes = () => useTopologyStoreBase((s) => s.topology.hubNodes);

/** Max certain count (for normalization) */
export const useMaxCertainCount = () => useTopologyStoreBase((s) => s.topology.maxCertainCount);

/** Centrality map */
export const useCentrality = () => useTopologyStoreBase((s) => s.topology.centrality);

/** Full affinity map (with hop stats) */
export const useFullAffinity = () => useTopologyStoreBase((s) => s.topology.fullAffinity);

/** Simple affinity map (backward compat) */
export const useNeighborAffinity = () => useTopologyStoreBase((s) => s.topology.neighborAffinity);

/** Local node prefix */
export const useLocalPrefix = () => useTopologyStoreBase((s) => s.topology.localPrefix);

/** Whether worker is currently computing */
export const useIsComputingTopology = () => useTopologyStoreBase((s) => s.isComputing);

/** Last computation time in ms */
export const useLastComputeTime = () => useTopologyStoreBase((s) => s.lastComputeTimeMs);

/** Timestamp of last update */
export const useTopologyLastUpdated = () => useTopologyStoreBase((s) => s.lastUpdated);

// ═══════════════════════════════════════════════════════════════════════════
// Computed selectors (derived data)
// ═══════════════════════════════════════════════════════════════════════════

// Memoized hub node set - create once per hubNodes array reference
let cachedHubNodeSet: Set<string> | null = null;
let cachedHubNodesSource: string[] | null = null;

/** Hub node set for O(1) lookup (memoized to prevent infinite re-renders) */
export const useHubNodeSet = () => useTopologyStoreBase((s) => {
  // Only create new Set if source array changed
  if (s.topology.hubNodes !== cachedHubNodesSource) {
    cachedHubNodesSource = s.topology.hubNodes;
    cachedHubNodeSet = new Set(s.topology.hubNodes);
  }
  return cachedHubNodeSet!;
});

/** Edge count */
export const useEdgeCount = () => useTopologyStoreBase((s) => s.topology.validatedEdges.length);

/** Has topology data */
export const useHasTopology = () => useTopologyStoreBase((s) => s.topology.edges.length > 0);

/** Network loops (cycles = redundant paths) */
export const useNetworkLoops = () => useTopologyStoreBase((s) => s.topology.loops);

/** Set of edge keys that are part of at least one loop */
export const useLoopEdgeKeys = () => useTopologyStoreBase((s) => s.topology.loopEdgeKeys);

/** Number of detected loops */
export const useLoopCount = () => useTopologyStoreBase((s) => s.topology.loops.length);

/** Whether any loops include the local node */
export const useHasLocalLoop = () => useTopologyStoreBase((s) => 
  s.topology.loops.some(loop => loop.includesLocal)
);

/** TX delay recommendations for hub nodes */
export const useTxDelayRecommendations = () => useTopologyStoreBase((s) => s.topology.txDelayRecommendations);
