/**
 * Topology Store
 * 
 * Zustand store for mesh topology data computed by the Web Worker.
 * Provides reactive access to topology edges, hub nodes, and centrality.
 */

import { create } from 'zustand';
import { topologyService, type MeshTopology, type NeighborAffinity, type TopologyEdge, type NetworkLoop, type TxDelayRecommendation, type PathRegistry, type ObservedPath, type NodeMobility, type PathHealth, type LastHopNeighbor, type DisambiguationStats } from '@/lib/topology-service';
import { createEmptyPathRegistry } from '@/lib/path-registry';

// Re-export types for consumers
export type { MeshTopology, NeighborAffinity, TopologyEdge, NetworkLoop, TxDelayRecommendation, PathRegistry, ObservedPath, NodeMobility, PathHealth, LastHopNeighbor, DisambiguationStats };

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
    weakEdges: [],
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
    // Phase 2: Path registry
    pathRegistry: createEmptyPathRegistry(),
    // Phase 4: Edge betweenness
    edgeBetweenness: new Map(),
    backboneEdges: [],
    // Phase 5: Mobile repeater detection
    nodeMobility: new Map(),
    mobileNodes: [],
    // Phase 7: Path health indicators
    pathHealth: [],
    // Last-hop neighbors (ground truth from packet paths)
    lastHopNeighbors: [],
    // Disambiguation statistics
    disambiguationStats: {
      totalPrefixes: 0,
      unambiguousPrefixes: 0,
      collisionPrefixes: 0,
      collisionRate: 0,
      avgConfidence: 0,
      lowConfidencePrefixes: [],
      highCollisionPrefixes: [],
      totalResolutions: 0,
    },
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

/** Weak edges (5+ packets but below validation threshold) */
export const useWeakEdges = () => useTopologyStoreBase((s) => s.topology.weakEdges);

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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Path Registry Selectors
// ═══════════════════════════════════════════════════════════════════════════

/** Full path registry */
export const usePathRegistry = () => useTopologyStoreBase((s) => s.topology.pathRegistry);

/** All observed paths */
export const useObservedPaths = () => useTopologyStoreBase((s) => s.topology.pathRegistry.paths);

/** Canonical (most-used) paths per endpoint pair */
export const useCanonicalPaths = () => useTopologyStoreBase((s) => s.topology.pathRegistry.canonicalPaths);

/** Number of unique paths */
export const useUniquePathCount = () => useTopologyStoreBase((s) => s.topology.pathRegistry.uniquePathCount);

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Edge Betweenness Selectors
// ═══════════════════════════════════════════════════════════════════════════

/** Edge betweenness centrality scores */
export const useEdgeBetweenness = () => useTopologyStoreBase((s) => s.topology.edgeBetweenness);

/** Backbone edges (high betweenness) */
export const useBackboneEdges = () => useTopologyStoreBase((s) => s.topology.backboneEdges);

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: Mobile Repeater Detection Selectors
// ═══════════════════════════════════════════════════════════════════════════

/** Node mobility tracking map */
export const useNodeMobility = () => useTopologyStoreBase((s) => s.topology.nodeMobility);

/** List of mobile node hashes */
export const useMobileNodes = () => useTopologyStoreBase((s) => s.topology.mobileNodes);

/** Check if a specific node is mobile */
export const useIsMobileNode = (hash: string) => useTopologyStoreBase((s) => 
  s.topology.mobileNodes.includes(hash)
);

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7: Path Health Selectors
// ═══════════════════════════════════════════════════════════════════════════

/** Path health indicators for top observed paths */
export const usePathHealth = () => useTopologyStoreBase((s) => s.topology.pathHealth);

/** Get top N healthy paths */
export const useTopHealthyPaths = (n: number = 10) => useTopologyStoreBase((s) => 
  s.topology.pathHealth.slice(0, n)
);

/** Get paths with declining health (negative trend) */
export const useDecliningPaths = () => useTopologyStoreBase((s) => 
  s.topology.pathHealth.filter(p => p.observationTrend < 0)
);

// ═══════════════════════════════════════════════════════════════════════════
// Last-Hop Neighbors (Ground Truth Direct RF Contacts)
// ═══════════════════════════════════════════════════════════════════════════

/** Last-hop neighbors (ground truth from packet paths - nodes that forwarded directly to us) */
export const useLastHopNeighbors = () => useTopologyStoreBase((s) => s.topology.lastHopNeighbors);

/** Number of last-hop neighbors */
export const useLastHopNeighborCount = () => useTopologyStoreBase((s) => s.topology.lastHopNeighbors.length);

// ═══════════════════════════════════════════════════════════════════════════
// Disambiguation Statistics Selectors
// ═══════════════════════════════════════════════════════════════════════════

/** Full disambiguation statistics */
export const useDisambiguationStats = () => useTopologyStoreBase((s) => s.topology.disambiguationStats);

/** Collision rate as percentage (0-100) */
export const useCollisionRate = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.collisionRate);

/** Average disambiguation confidence (0-1) */
export const useAvgDisambiguationConfidence = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.avgConfidence);

/** Number of prefixes with collisions */
export const useCollisionPrefixCount = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.collisionPrefixes);

/** Prefixes with low confidence (< 0.5) */
export const useLowConfidencePrefixes = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.lowConfidencePrefixes);

/** Top 5 prefixes with most candidates (worst collisions) */
export const useHighCollisionPrefixes = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.highCollisionPrefixes);

/** Whether disambiguation data is available (non-zero prefixes) */
export const useHasDisambiguationData = () => useTopologyStoreBase((s) => s.topology.disambiguationStats.totalPrefixes > 0);
