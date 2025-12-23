/**
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║                         MESH TOPOLOGY ANALYSIS                                ║
 * ╠═══════════════════════════════════════════════════════════════════════════════╣
 * ║ Analyzes packet paths to build a network graph with confidence-weighted       ║
 * ║ edges. Uses the centralized prefix disambiguation system for consistent       ║
 * ║ prefix resolution.                                                            ║
 * ║                                                                               ║
 * ║ ARCHITECTURE:                                                                 ║
 * ║ ┌─────────────────────────────────────────────────────────────────────────┐   ║
 * ║ │ Phase 1: Directional Traffic Tracking (forwardCount/reverseCount)      │   ║
 * ║ │ Phase 2: Path Sequence Registry (path-registry.ts)                     │   ║
 * ║ │ Phase 3: Flood vs Direct Route Detection                               │   ║
 * ║ │ Phase 4: Edge Betweenness Centrality (with symmetry normalization)     │   ║
 * ║ │ Phase 5: Mobile Repeater Detection                                     │   ║
 * ║ │ Phase 6: TX Delay Recommendations                                      │   ║
 * ║ │ Phase 7: Path Health Indicators                                        │   ║
 * ║ └─────────────────────────────────────────────────────────────────────────┘   ║
 * ║                                                                               ║
 * ║ KEY DEPENDENCIES:                                                             ║
 * ║   - prefix-disambiguation.ts: Resolves 2-char prefix collisions              ║
 * ║   - path-utils.ts: Centralized path parsing utilities                        ║
 * ║   - path-registry.ts: Observed path sequence tracking                        ║
 * ║                                                                               ║
 * ║ FILE ORGANIZATION (~2250 lines):                                              ║
 * ║   Lines 1-290:     Interfaces & Constants                                    ║
 * ║   Lines 291-506:   Neighbor Affinity System                                  ║
 * ║   Lines 507-627:   Prefix Matching (VESTIGIAL - see note)                    ║
 * ║   Lines 628-800:   Loop Detection (H₁ Homology)                              ║
 * ║   Lines 801-1070:  TX Delay Recommendations (Phase 6)                        ║
 * ║   Lines 1071-1203: Edge Betweenness Centrality (Phase 4)                     ║
 * ║   Lines 1204-1320: Mobile Repeater Detection (Phase 5)                       ║
 * ║   Lines 1321-1484: Path Health Indicators (Phase 7)                          ║
 * ║   Lines 1485-2054: Main buildMeshTopology() function                         ║
 * ║   Lines 2055-2254: Edge Styling Utilities                                    ║
 * ║                                                                               ║
 * ║ VESTIGIAL/REDUNDANT CODE (candidates for removal):                           ║
 * ║   - matchPrefix(): Largely superseded by prefix-disambiguation.ts            ║
 * ║   - getEdgeColor(): Deprecated, replaced by getEdgeColorByHopDistance()      ║
 * ║   - getUncertainEdgeColor(): Uncertain edges no longer rendered              ║
 * ║   - MeshTopology.uncertainEdges: Always empty, kept for API compat           ║
 * ║   - MeshTopology.certainEdges: Alias for validatedEdges                      ║
 * ║   - calculateDistance/getProximityScore: Duplicated in disambiguation.ts     ║
 * ║                                                                               ║
 * ║ TODO: Future improvements                                                    ║
 * ║   - Extract edge styling to separate module (edge-styling.ts)                ║
 * ║   - Move neighbor affinity to its own module                                 ║
 * ║   - Consider Web Worker for buildMeshTopology (already done in service)      ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 */

import { Packet, NeighborInfo } from '@/types/api';
import { 
  buildPrefixLookup, 
  resolvePrefix, 
  getDisambiguationStats,
} from './prefix-disambiguation';
import {
  parsePacketPath, 
  getHashPrefix, 
  prefixMatches,
  getPositionFromIndex,
  getHopDistanceFromLocal,
} from './path-utils';
import {
  buildPathRegistry,
  type PathRegistry,
} from './path-registry';
import {
  calculateDistance,
  getProximityScore,
} from './geo-utils';

// Re-export edge styling functions for backward compatibility
// These are now defined in edge-styling.ts but consumers may import from mesh-topology
export {
  getEdgeWeight,
  getEdgeColor,
  getEdgeColorByHopDistance,
  getEdgeWeightByHopDistance,
  getCertainEdgeWeight,
  getUncertainEdgeColor,
  getLinkQualityColor,
  getLinkQualityWeight,
  LINK_QUALITY_THRESHOLDS,
  EDGE_WEIGHT_THRESHOLDS,
} from './edge-styling';

/** Represents a directed edge between two nodes */
export interface TopologyEdge {
  fromHash: string;
  toHash: string;
  /** Unique key for this edge (sorted hashes) */
  key: string;
  /** Number of packets seen with this connection */
  packetCount: number;
  /** Average confidence across all observations */
  avgConfidence: number;
  /** Strength score (0-1) combining count, confidence, and recency */
  strength: number;
  /** Average recency of observations (0-1, higher = more recent). Uses 12-hour half-life decay. */
  avgRecency: number;
  /** Minimum hop distance from local node (0 = directly connected to local, 1 = one hop away, etc.) */
  hopDistanceFromLocal: number;
  /** Whether this edge connects to a hub node (high centrality) */
  isHubConnection: boolean;
  /** 
   * Whether this edge is 100% certain (both endpoints uniquely matched) 
   * vs inferred (at least one endpoint had multiple possible matches)
   */
  isCertain: boolean;
  /** Number of times this exact connection was observed with 100% certainty */
  certainCount: number;
  /** Whether this edge is part of at least one detected loop (redundant path) */
  isLoopEdge?: boolean;
  
  // === DIRECTIONAL TRACKING (Phase 1) ===
  /** Observations in fromHash→toHash direction */
  forwardCount: number;
  /** Observations in toHash→fromHash direction */
  reverseCount: number;
  /** Symmetry ratio: min(forward,reverse) / max(forward,reverse), 1.0 = perfectly symmetric */
  symmetryRatio: number;
  /** Which direction has more traffic */
  dominantDirection: 'forward' | 'reverse' | 'balanced';
  
  // === FLOOD vs DIRECT TRACKING (Phase 3) ===
  /** Number of observations from flood-routed packets */
  floodCount: number;
  /** Number of observations from direct-routed packets */
  directCount: number;
  /** True if >50% of observations are from direct-routed packets (ground truth path) */
  isDirectPathEdge: boolean;
}

/**
 * Represents a detected loop (cycle) in the mesh network.
 * Loops indicate redundant paths — critical for mesh resilience.
 * If one link in a loop fails, traffic can route around via the other path.
 */
export interface NetworkLoop {
  /** Unique identifier for this loop */
  id: string;
  /** Edge keys that form this loop */
  edgeKeys: string[];
  /** Node hashes in the loop (in traversal order) */
  nodes: string[];
  /** Number of edges in the loop */
  size: number;
  /** Average certainCount across edges in the loop */
  avgCertainCount: number;
  /** Minimum certainCount across loop edges (weakest link determines reliability) */
  minCertainCount: number;
  /** Whether local node is part of this loop (high priority for display) */
  includesLocal: boolean;
  /** Loop strength: min certainCount normalized to 0-1 */
  strength: number;
}

/** Minimum validations required for an edge to be rendered */
export const MIN_EDGE_VALIDATIONS = 5;

/** Confidence threshold for counting an edge as "certain" */
export const CERTAINTY_CONFIDENCE_THRESHOLD = 0.6;

/** Maximum edges to render (performance cap) */
export const MAX_RENDERED_EDGES = 100;

/** Minimum edge packet count required for TX delay recommendations */
export const MIN_PACKETS_FOR_TX_DELAY = 100;

/**
 * Recommended TX delay settings for a node based on traffic analysis.
 * Used to suggest optimal tx_delay_factor and direct.tx_delay_factor.
 * 
 * Phase 6 enhancements incorporate MeshCore routing semantics:
 * - Path position affects transmission timing (earlier nodes transmit first)
 * - Flood participation rate indicates congestion potential
 * - Path diversity shows how many routes use this node
 */
export interface TxDelayRecommendation {
  /** Recommended tx_delay_factor (0.5-1.5, higher = more conservative) */
  txDelayFactor: number;
  /** Recommended direct.tx_delay_factor (typically 30-40% of txDelayFactor) */
  directTxDelayFactor: number;
  /** Traffic intensity: packets per minute through this node */
  trafficIntensity: number;
  /** Number of direct (1-hop) neighbors observed */
  directNeighborCount: number;
  /** Estimated collision risk (0-1, higher = more delay needed) */
  collisionRisk: number;
  /** Confidence in recommendation (0-1, based on sample size) */
  confidence: number;
  /** True if insufficient data (<100 packets) to make recommendation */
  insufficientData?: boolean;
  
  // === PHASE 6: MeshCore-aligned path metrics ===
  /** Average path position (1 = first hop after source, higher = closer to destination) */
  avgPathPosition: number;
  /** Variance in path position (low = consistent role, high = varied usage) */
  pathPositionVariance: number;
  /** Percentage of flood packets this node forwarded (0-1) */
  floodParticipationRate: number;
  /** Number of distinct paths using this node */
  pathDiversity: number;
  /** Recommended additional delay based on path position (ms) */
  positionDelayMs: number;
}

/** Minimum packets for weak edge (rendered underneath validated topology) */
export const MIN_WEAK_EDGE_PACKETS = 2;

/**
 * Node mobility tracking for Phase 5.
 * Identifies nodes that may be mobile (frequently appear/disappear from paths).
 */
export interface NodeMobility {
  /** Node hash */
  hash: string;
  /** How often this node appears/disappears from paths (0-1, higher = more volatile) */
  pathVolatility: number;
  /** How many distinct paths this node appears in */
  pathDiversity: number;
  /** Average time this node stays in paths (hours) */
  avgPathLifespanHours: number;
  /** True if volatility > 0.3 (likely a mobile node) */
  isMobile: boolean;
  /** Last time this node was seen in a path (unix ms) */
  lastSeen: number;
  /** Number of time windows where node was active vs total windows */
  activeWindowRatio: number;
}

/**
 * Path health indicator for Phase 7.
 * Provides health score and metrics for frequently observed paths.
 */
export interface PathHealth {
  /** Unique key for this path (joined hops with >) */
  pathKey: string;
  /** The path as array of 2-char hex prefixes */
  hops: string[];
  /** Overall health score (0-1, higher = healthier path) */
  healthScore: number;
  /** Key of the weakest edge in this path */
  weakestLinkKey: string | null;
  /** Confidence of the weakest edge */
  weakestLinkConfidence: number;
  /** Average edge certainty across the path */
  avgEdgeCertainty: number;
  /** Observation trend: positive = increasing, negative = declining */
  observationTrend: number;
  /** Number of alternate paths to the same destination */
  alternatePathsCount: number;
  /** Estimated latency in ms (based on hop count and path type) */
  estimatedLatencyMs: number;
  /** Total observations of this path */
  observationCount: number;
  /** Route type (flood vs direct) */
  routeType: 'flood' | 'direct' | 'mixed';
  /** Last time this path was observed (unix timestamp) */
  lastSeen: number;
  /** Whether this path involves a hub node */
  involvesHub: boolean;
}

/**
 * A neighbor identified by appearing as the last hop in packet paths.
 * This is ground truth: they forwarded packets directly to our local node.
 */
export interface LastHopNeighbor {
  /** Full hash of the neighbor (resolved from prefix via disambiguation) */
  hash: string;
  /** 2-char prefix as seen in packet paths */
  prefix: string;
  /** Number of times this node was the last hop */
  count: number;
  /** Disambiguation confidence (0-1) */
  confidence: number;
  /** Average RSSI of packets received via this neighbor */
  avgRssi: number | null;
  /** Average SNR of packets received via this neighbor */
  avgSnr: number | null;
  /** Most recent packet timestamp from this neighbor */
  lastSeen: number;
}

/** Result of topology analysis */
export interface MeshTopology {
  /** All edges with 3+ validations */
  edges: TopologyEdge[];
  /** Edges meeting validation threshold (for rendering) */
  validatedEdges: TopologyEdge[];
  /** Weak edges: 5+ packets but below validation threshold (rendered underneath) */
  weakEdges: TopologyEdge[];
  /** 
   * @deprecated Use validatedEdges instead. This is an alias kept for API compatibility.
   * TODO: Remove in next major version after updating all consumers.
   */
  certainEdges: TopologyEdge[];
  /** 
   * @deprecated Uncertain edges are no longer rendered. Always returns empty array.
   * TODO: Remove in next major version after updating all consumers.
   */
  uncertainEdges: TopologyEdge[];
  /** Map from edge key to edge for quick lookup */
  edgeMap: Map<string, TopologyEdge>;
  /** Max packet count across all edges (for normalization) */
  maxPacketCount: number;
  /** Max certain count for normalization of solid line thickness */
  maxCertainCount: number;
  /** Neighbor affinity scores (hash -> combined score for backward compat) */
  neighborAffinity: Map<string, number>;
  /** Full affinity data with hop statistics (hash -> NeighborAffinity) */
  fullAffinity: Map<string, NeighborAffinity>;
  /** Local node's 2-char prefix (derived from localHash) */
  localPrefix: string | null;
  /** Node centrality scores (hash -> betweenness centrality) */
  centrality: Map<string, number>;
  /** Hub nodes identified by high centrality (sorted by centrality desc) */
  hubNodes: string[];
  /** Detected loops (cycles) in the network - indicates redundant paths */
  loops: NetworkLoop[];
  /** Set of edge keys that are part of at least one loop */
  loopEdgeKeys: Set<string>;
  /** TX delay recommendations for all nodes with sufficient data (hash -> recommendation) */
  txDelayRecommendations: Map<string, TxDelayRecommendation>;
  
  // === PHASE 2: Path Sequence Tracking ===
  /** Registry of all observed paths for route analysis */
  pathRegistry: PathRegistry;
  
  // === PHASE 4: Edge Betweenness Centrality ===
  /** Edge betweenness scores (edge key -> normalized score 0-1) */
  edgeBetweenness: Map<string, number>;
  /** Backbone edges identified by high betweenness (top edges carrying most traffic) */
  backboneEdges: string[];
  
  // === PHASE 5: Mobile Repeater Detection ===
  /** Node mobility tracking (hash -> NodeMobility) */
  nodeMobility: Map<string, NodeMobility>;
  /** Nodes identified as potentially mobile */
  mobileNodes: string[];
  
  // === PHASE 7: Path Health Indicators ===
  /** Health metrics for top observed paths */
  pathHealth: PathHealth[];
  
  // === LAST-HOP NEIGHBORS (Ground Truth) ===
  /** 
   * Neighbors identified by appearing as the last hop in packet paths.
   * This is ground truth from actual traffic: these nodes forwarded packets directly to us.
   * Sorted by count descending (most traffic first).
   */
  lastHopNeighbors: LastHopNeighbor[];
}

interface EdgeAccumulator {
  fromHash: string;
  toHash: string;
  key: string;
  count: number;
  confidenceSum: number;
  /** Minimum hop distance from local for this edge (lower = closer to local) */
  minHopDistance: number;
  /** How many times this edge was observed at each hop distance */
  hopDistanceCounts: number[];
  /** Number of 100% certain observations (both endpoints uniquely matched) */
  certainCount: number;
  /** Number of uncertain observations (at least one ambiguous endpoint) */
  uncertainCount: number;
  
  // === DIRECTIONAL TRACKING (Phase 1) ===
  /** Observations where traffic flowed fromHash→toHash */
  forwardCount: number;
  /** Observations where traffic flowed toHash→fromHash */
  reverseCount: number;
  
  // === FLOOD vs DIRECT TRACKING (Phase 3) ===
  /** Observations from flood-routed packets (route_type 0) */
  floodCount: number;
  /** Observations from direct-routed packets (route_type 1) */
  directCount: number;
  
  // === RECENCY TRACKING ===
  /** Sum of recency scores for all observations (for averaging) */
  recencySum: number;
}

// Re-export from path-utils for backward compatibility
export { getHashPrefix, prefixMatches } from './path-utils';

// Geographic functions are now imported from geo-utils.ts
// See: calculateDistance, getProximityScore, hasValidCoordinates

/** Combined affinity score for a neighbor */
export interface NeighborAffinity {
  hash: string;
  /** How often this neighbor appears in any path position */
  frequency: number;
  /** How often this neighbor appears as direct forwarder (second-to-last hop = 1-hop) */
  directForwardCount: number;
  /** Distance to local node in meters (null if unknown) */
  distanceMeters: number | null;
  /** Proximity score 0-1 based on Haversine distance */
  proximityScore: number;
  /** Hop position counts: index 0 = 1-hop (second-to-last), 1 = 2-hop, etc. */
  hopPositionCounts: number[];
  /** Average hop distance from local (1 = direct neighbor, 2 = 2-hop, etc.) */
  avgHopDistance: number;
  /** Most common hop position (1 = direct, 2 = 2-hop, etc.) */
  typicalHopPosition: number;
  /** Hop consistency score 0-1 (higher = more consistent hop position) */
  hopConsistencyScore: number;
  /** Normalized frequency score 0-1 */
  frequencyScore: number;
  /** Combined multi-factor score: haversine (0.3) + hopConsistency (0.3) + frequency (0.4) */
  combinedScore: number;
}

/**
 * Build neighbor affinity map from packets and proximity.
 * Multi-factor scoring combining:
 * - Haversine distance (physical proximity)
 * - Hop position (where in paths this node typically appears)
 * - Frequency (how often this node appears in paths)
 * 
 * @param packets - All packets to analyze
 * @param neighbors - Known neighbors with location data
 * @param localLat - Local node latitude
 * @param localLon - Local node longitude  
 * @param localHash - Local node's hash
 */
export function buildNeighborAffinity(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localLat?: number,
  localLon?: number,
  localHash?: string
): Map<string, NeighborAffinity> {
  const affinity = new Map<string, NeighborAffinity>();
  const hasLocalCoords = localLat !== undefined && localLon !== undefined &&
    (localLat !== 0 || localLon !== 0);
  
  // Initialize affinity for all neighbors
  for (const [hash, neighbor] of Object.entries(neighbors)) {
    let distanceMeters: number | null = null;
    let proximityScore = 0.5; // Default middle score
    
    if (hasLocalCoords && neighbor.latitude && neighbor.longitude &&
        (neighbor.latitude !== 0 || neighbor.longitude !== 0)) {
      distanceMeters = calculateDistance(
        localLat!, localLon!,
        neighbor.latitude, neighbor.longitude
      );
      proximityScore = getProximityScore(distanceMeters);
    }
    
    // Boost proximity score for known zero_hop (direct radio contact) neighbors
    if (neighbor.zero_hop) {
      proximityScore = Math.max(proximityScore, 0.9);
    }
    
    affinity.set(hash, {
      hash,
      frequency: 0,
      directForwardCount: 0,
      distanceMeters,
      proximityScore,
      hopPositionCounts: [0, 0, 0, 0, 0], // Track up to 5 hop positions
      avgHopDistance: 0,
      typicalHopPosition: 0,
      hopConsistencyScore: 0,
      frequencyScore: 0,
      combinedScore: 0,
    });
  }
  
  // Analyze packets for hop positions and frequency
  // Use centralized path parsing from path-utils.ts
  for (const packet of packets) {
    const parsed = parsePacketPath(packet, localHash);
    
    if (parsed && parsed.effectiveLength >= 1) {
      const path = parsed.effective; // Local already stripped
      
      // Process the path - last element is the node that forwarded to us (1-hop)
      // Hop positions: last element = 1-hop (direct forwarder), second-to-last = 2-hop, etc.
      for (let i = 0; i < path.length; i++) {
        const prefix = path[i];
        // hopDistance from local: position 1 = direct, position 2 = 2-hop, etc.
        const position = getPositionFromIndex(i, parsed.effectiveLength);
        
        // Find matching neighbors and update their hop stats
        for (const [hash, aff] of affinity) {
          if (prefixMatches(prefix, hash)) {
            aff.frequency++;
            
            // Track hop position (index 0 = 1-hop, index 1 = 2-hop, etc.)
            const hopIndex = Math.min(position - 1, 4); // Cap at 5 positions
            aff.hopPositionCounts[hopIndex]++;
            
            // Track direct forwards specifically (position 1 = last forwarder)
            if (position === 1) {
              aff.directForwardCount++;
            }
          }
        }
      }
    }
    
    // Also count direct packets (empty path) from src_hash
    if ((!parsed || parsed.effectiveLength === 0) && packet.src_hash) {
      const srcAff = affinity.get(packet.src_hash);
      if (srcAff) {
        srcAff.frequency++;
        srcAff.directForwardCount++;
        srcAff.hopPositionCounts[0]++; // Direct = 1-hop
      }
    }
  }
  
  // Calculate derived scores
  let maxFrequency = 0;
  for (const aff of affinity.values()) {
    maxFrequency = Math.max(maxFrequency, aff.frequency);
  }
  
  for (const aff of affinity.values()) {
    // Calculate average hop distance
    let totalHops = 0;
    let weightedSum = 0;
    let maxCount = 0;
    let typicalPosition = 1;
    
    for (let i = 0; i < aff.hopPositionCounts.length; i++) {
      const count = aff.hopPositionCounts[i];
      const hopDist = i + 1; // 1-indexed hop distance
      totalHops += count;
      weightedSum += count * hopDist;
      
      if (count > maxCount) {
        maxCount = count;
        typicalPosition = hopDist;
      }
    }
    
    aff.avgHopDistance = totalHops > 0 ? weightedSum / totalHops : 0;
    aff.typicalHopPosition = typicalPosition;
    
    // Hop consistency score: how concentrated are appearances at typical position?
    // Higher = more consistent (appears at same hop distance consistently)
    if (totalHops > 0 && maxCount > 0) {
      aff.hopConsistencyScore = maxCount / totalHops;
    }
    
    // Frequency score (normalized)
    aff.frequencyScore = maxFrequency > 0 ? aff.frequency / maxFrequency : 0;
    
    // Multi-factor combined score:
    // - proximityScore (Haversine): 30% weight
    // - hopConsistencyScore: 30% weight (consistent hop position = more reliable)
    // - frequencyScore: 40% weight (frequent appearances = more data = more reliable)
    aff.combinedScore = 
      aff.proximityScore * 0.3 + 
      aff.hopConsistencyScore * 0.3 + 
      aff.frequencyScore * 0.4;
  }
  
  return affinity;
}


// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║ VESTIGIAL: matchPrefix()                                                      ║
// ╠═══════════════════════════════════════════════════════════════════════════════╣
// ║ This function is LARGELY SUPERSEDED by prefix-disambiguation.ts which         ║
// ║ provides multi-factor scoring (position, co-occurrence, geography, recency).  ║
// ║                                                                               ║
// ║ STILL USED BY:                                                                ║
// ║   - PathMapVisualization.tsx: Fallback when prefixLookup unavailable          ║
// ║   - buildNeighborAffinity(): Uses prefixMatches for hop position tracking     ║
// ║                                                                               ║
// ║ MIGRATION DECISION:                                                           ║
// ║   Full migration to resolvePrefix() would require pre-computing prefixLookup  ║
// ║   before buildNeighborAffinity(), creating a circular dependency. The current ║
// ║   approach of using prefixLookup when available (in PathMapVisualization)     ║
// ║   and falling back to matchPrefix() is acceptable.                            ║
// ║                                                                               ║
// ║ KEEP EXPORTED: Required by PathMapVisualization.tsx                           ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝
/**
 * Match a 2-character prefix to known node hashes.
 * Returns matching hashes and the probability based on combined affinity scores.
 * 
 * @deprecated Prefer resolvePrefix() from prefix-disambiguation.ts for new code.
 *             This function lacks position/co-occurrence/geographic scoring.
 * 
 * @param prefix - The 2-char hex prefix to match
 * @param neighbors - Known neighbors
 * @param localHash - Local node's full hash
 * @param neighborAffinity - Optional affinity map (combined scores) for tiebreaking
 * @param isLastHop - If true and prefix matches local, return local with high confidence
 */
export function matchPrefix(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  neighborAffinity?: Map<string, number | NeighborAffinity>,
  isLastHop: boolean = false
): { matches: string[]; probability: number; bestMatch: string | null } {
  const normalizedPrefix = prefix.toUpperCase();
  const matches: string[] = [];
  
  // Check local node first
  const localMatches = localHash && prefixMatches(normalizedPrefix, localHash);
  if (localMatches) {
    matches.push(localHash);
  }
  
  // Check neighbors
  for (const hash of Object.keys(neighbors)) {
    if (prefixMatches(normalizedPrefix, hash)) {
      matches.push(hash);
    }
  }
  
  // IMPORTANT: For last hop detection, we need to be careful about prefix collisions.
  // If local matches AND a neighbor also matches, we should NOT auto-prefer local
  // because the last hop in a path is our direct neighbor who forwarded to us.
  // Local can't forward packets to itself!
  //
  // Only return local as bestMatch if it's the ONLY match (no collision).
  if (isLastHop && localMatches && localHash && matches.length === 1) {
    return {
      matches,
      probability: 1, // High confidence - only local matches, this is us receiving
      bestMatch: localHash,
    };
  }
  
  // If last hop with collision: prefer the neighbor (non-local match)
  // This is the node that forwarded the packet to us
  if (isLastHop && localMatches && matches.length > 1) {
    const nonLocalMatches = matches.filter(h => h !== localHash);
    if (nonLocalMatches.length === 1) {
      // Only one neighbor matches - that's our direct forwarder
      return {
        matches,
        probability: 1, // High confidence - this neighbor forwarded to us
        bestMatch: nonLocalMatches[0],
      };
    }
    // Multiple neighbors match - use affinity to pick best one (handled below)
  }
  
  // Calculate base probability
  const baseProbability = matches.length > 0 ? 1 / matches.length : 0;
  
  // Determine best match using affinity for tiebreaking
  // IMPORTANT: Sort matches for deterministic behavior across devices
  const sortedMatches = [...matches].sort();
  
  let bestMatch: string | null = null;
  let bestScore = -1;
  
  if (sortedMatches.length === 1) {
    bestMatch = sortedMatches[0];
  } else if (sortedMatches.length > 1 && neighborAffinity) {
    // Use combined affinity scores to pick the most likely candidate
    for (const hash of sortedMatches) {
      const affValue = neighborAffinity.get(hash);
      // Support both old (number) and new (NeighborAffinity) formats
      const score = affValue 
        ? (typeof affValue === 'number' ? affValue : affValue.combinedScore)
        : 0;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = hash;
      }
    }
    // If no affinity data or tie, fall back to first sorted match (deterministic)
    if (!bestMatch) bestMatch = sortedMatches[0];
  } else if (sortedMatches.length > 0) {
    bestMatch = sortedMatches[0];
  }
  
  // Calculate probability - boost if we have strong affinity data
  let probability = baseProbability;
  if (matches.length > 1 && neighborAffinity && bestScore > 0) {
    // Sum all scores for matches
    let totalScore = 0;
    for (const hash of matches) {
      const affValue = neighborAffinity.get(hash);
      totalScore += affValue 
        ? (typeof affValue === 'number' ? affValue : affValue.combinedScore)
        : 0;
    }
    if (totalScore > 0) {
      // Probability based on score ratio (capped at 0.95 for multi-match)
      probability = Math.min(0.95, bestScore / totalScore);
    }
  }
  
  return { matches, probability, bestMatch };
}

/**
 * Generate edge key from two hashes (sorted for consistency).
 */
function makeEdgeKey(hash1: string, hash2: string): string {
  return [hash1, hash2].sort().join('-');
}

// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║ LOOP DETECTION (H₁ Homology)                                                  ║
// ╠═══════════════════════════════════════════════════════════════════════════════╣
// ║ Detects cycles in the mesh network graph. Cycles represent redundant paths   ║
// ║ critical for mesh resilience. If one link in a cycle fails, traffic can      ║
// ║ route around via the alternate path.                                          ║
// ║                                                                               ║
// ║ Algorithm: BFS-based alternate path detection                                 ║
// ║ Complexity: O(E × (V + E)) worst case, typically much faster                  ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝

/**
 * Find all loops (cycles) in the network graph.
 * 
 * Algorithm: For each edge, temporarily remove it and check if endpoints
 * are still connected. If yes, there's an alternate path = a loop exists.
 * Then reconstruct the loop by finding the shortest alternate path.
 * 
 * Complexity: O(E * (V + E)) in worst case, but typically much faster
 * due to sparse mesh graphs and early termination.
 * 
 * @param edges - Validated edges to analyze
 * @param localHash - Local node hash (for includesLocal flag)
 * @param maxCertainCount - For normalizing loop strength
 */
export function findNetworkLoops(
  edges: TopologyEdge[],
  localHash?: string,
  maxCertainCount: number = 1
): { loops: NetworkLoop[]; loopEdgeKeys: Set<string> } {
  if (edges.length < 3) {
    // Need at least 3 edges to form a loop
    return { loops: [], loopEdgeKeys: new Set() };
  }
  
  // Build adjacency list for graph traversal
  const adjacency = new Map<string, Set<string>>();
  const edgeByKey = new Map<string, TopologyEdge>();
  
  for (const edge of edges) {
    edgeByKey.set(edge.key, edge);
    
    if (!adjacency.has(edge.fromHash)) {
      adjacency.set(edge.fromHash, new Set());
    }
    if (!adjacency.has(edge.toHash)) {
      adjacency.set(edge.toHash, new Set());
    }
    
    adjacency.get(edge.fromHash)!.add(edge.toHash);
    adjacency.get(edge.toHash)!.add(edge.fromHash);
  }
  
  const loops: NetworkLoop[] = [];
  const loopEdgeKeys = new Set<string>();
  const seenLoopSignatures = new Set<string>(); // Prevent duplicate loops
  
  /**
   * BFS to find shortest path between two nodes, avoiding a specific edge.
   * Returns the path as array of node hashes, or null if no path exists.
   */
  function findAlternatePath(
    start: string,
    end: string,
    excludeEdgeKey: string
  ): string[] | null {
    if (start === end) return [start];
    
    const visited = new Set<string>([start]);
    const queue: { node: string; path: string[] }[] = [{ node: start, path: [start] }];
    
    while (queue.length > 0) {
      const { node, path } = queue.shift()!;
      const neighbors = adjacency.get(node);
      
      if (!neighbors) continue;
      
      for (const neighbor of neighbors) {
        // Skip the excluded edge
        const edgeKey = makeEdgeKey(node, neighbor);
        if (edgeKey === excludeEdgeKey) continue;
        
        if (neighbor === end) {
          // Found the destination
          return [...path, neighbor];
        }
        
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, path: [...path, neighbor] });
        }
      }
    }
    
    return null; // No alternate path found
  }
  
  // For each edge, check if removing it still leaves endpoints connected
  // If so, we have a loop
  for (const edge of edges) {
    const alternatePath = findAlternatePath(edge.fromHash, edge.toHash, edge.key);
    
    if (alternatePath && alternatePath.length >= 2) {
      // Found a loop! The loop consists of:
      // - The direct edge (edge.fromHash -> edge.toHash)
      // - The alternate path (fromHash -> ... -> toHash)
      
      // Build the loop's edge keys
      const loopNodes = alternatePath;
      const loopEdges: string[] = [edge.key]; // Include the original edge
      
      // Add edges from the alternate path
      for (let i = 0; i < alternatePath.length - 1; i++) {
        const pathEdgeKey = makeEdgeKey(alternatePath[i], alternatePath[i + 1]);
        loopEdges.push(pathEdgeKey);
      }
      
      // Create a canonical signature to detect duplicate loops
      // Sort nodes and join to create a unique identifier
      const signature = [...loopNodes].sort().join(',');
      
      if (seenLoopSignatures.has(signature)) {
        continue; // Skip duplicate loop
      }
      seenLoopSignatures.add(signature);
      
      // Calculate loop statistics
      let totalCertainCount = 0;
      let minCertainCount = Infinity;
      
      for (const edgeKey of loopEdges) {
        const loopEdge = edgeByKey.get(edgeKey);
        if (loopEdge) {
          totalCertainCount += loopEdge.certainCount;
          minCertainCount = Math.min(minCertainCount, loopEdge.certainCount);
          loopEdgeKeys.add(edgeKey);
        }
      }
      
      const avgCertainCount = loopEdges.length > 0 
        ? totalCertainCount / loopEdges.length 
        : 0;
      
      const includesLocal = localHash 
        ? loopNodes.includes(localHash)
        : false;
      
      const loop: NetworkLoop = {
        id: `loop-${loops.length}`,
        edgeKeys: loopEdges,
        nodes: loopNodes,
        size: loopEdges.length,
        avgCertainCount,
        minCertainCount: minCertainCount === Infinity ? 0 : minCertainCount,
        includesLocal,
        strength: maxCertainCount > 0 
          ? (minCertainCount === Infinity ? 0 : minCertainCount / maxCertainCount)
          : 0,
      };
      
      loops.push(loop);
    }
  }
  
  // Sort loops: local-including first, then by strength (weakest link)
  loops.sort((a, b) => {
    if (a.includesLocal !== b.includesLocal) {
      return a.includesLocal ? -1 : 1;
    }
    return b.strength - a.strength;
  });
  
  return { loops, loopEdgeKeys };
}

/**
 * Calculate TX delay recommendations for all nodes based on their unique network position.
 * 
 * The algorithm analyzes each node's unique situation:
 * - Edge packet count (total packets flowing through edges connected to this node)
 * - Number of direct neighbors (topology edges connected to this node)
 * - Edge validation strength (how well-validated the node's connections are)
 * 
 * Phase 6 enhancements:
 * - Path position tracking (first hop = higher delay needed)
 * - Flood participation rate (congestion indicator)
 * - Path diversity (routing importance)
 * 
 * Nodes with <100 packets get an "insufficient data" result.
 * 
 * @param edges - All topology edges
 * @param nodePathCounts - Map of node hash -> number of paths it appeared in
 * @param packets - All packets for timing analysis
 * @param pathRegistry - Registry of observed paths for Phase 6 metrics
 * @param neighbors - Neighbor map for prefix matching (reserved for future use)
 * @returns Map of node hash -> TxDelayRecommendation
 */
function calculateNodeTxDelays(
  edges: TopologyEdge[],
  nodePathCounts: Map<string, number>,
  packets: Packet[],
  pathRegistry: PathRegistry,
  _neighbors: Record<string, NeighborInfo>
): Map<string, TxDelayRecommendation> {
  const recommendations = new Map<string, TxDelayRecommendation>();
  
  if (edges.length === 0 || packets.length === 0) {
    return recommendations;
  }
  
  // Collect all unique node hashes from edges
  const allNodes = new Set<string>();
  for (const edge of edges) {
    allNodes.add(edge.fromHash);
    allNodes.add(edge.toHash);
  }
  
  // Calculate time span of packet data (for packets/minute calculation)
  const timestamps = packets
    .map(p => p.timestamp)
    .filter((t): t is number => t !== undefined && t > 0)
    .sort((a, b) => a - b);
  
  const timeSpanMinutes = timestamps.length >= 2
    ? (timestamps[timestamps.length - 1] - timestamps[0]) / 60
    : 1;
  
  // Pre-compute per-node metrics
  const nodeMetrics = new Map<string, {
    edgePacketCount: number;      // Total packets on edges touching this node
    directNeighborCount: number;  // Count of unique neighbors from edges
    avgEdgeValidation: number;    // Average certainCount of connected edges
    maxEdgeValidation: number;    // Max certainCount of connected edges
    pathCount: number;            // Paths this node appeared in
  }>();
  
  // Find max values across all nodes for relative comparison
  let maxEdgePacketCount = 0;
  let maxPathCount = 0;
  let maxNeighborCount = 0;
  
  for (const nodeHash of allNodes) {
    // Find all edges connected to this node
    const connectedEdges = edges.filter(
      e => e.fromHash === nodeHash || e.toHash === nodeHash
    );
    
    // Count unique neighbors from edges
    const neighborHashes = new Set<string>();
    let totalPacketCount = 0;
    let totalCertainCount = 0;
    let maxCertain = 0;
    
    for (const edge of connectedEdges) {
      const otherHash = edge.fromHash === nodeHash ? edge.toHash : edge.fromHash;
      neighborHashes.add(otherHash);
      totalPacketCount += edge.packetCount;
      totalCertainCount += edge.certainCount;
      maxCertain = Math.max(maxCertain, edge.certainCount);
    }
    
    const directNeighborCount = neighborHashes.size;
    const avgValidation = connectedEdges.length > 0 
      ? totalCertainCount / connectedEdges.length 
      : 0;
    const pathCount = nodePathCounts.get(nodeHash) || 0;
    
    nodeMetrics.set(nodeHash, {
      edgePacketCount: totalPacketCount,
      directNeighborCount,
      avgEdgeValidation: avgValidation,
      maxEdgeValidation: maxCertain,
      pathCount,
    });
    
    // Track maximums (only from nodes with sufficient data)
    if (totalPacketCount >= MIN_PACKETS_FOR_TX_DELAY) {
      maxEdgePacketCount = Math.max(maxEdgePacketCount, totalPacketCount);
      maxPathCount = Math.max(maxPathCount, pathCount);
      maxNeighborCount = Math.max(maxNeighborCount, directNeighborCount);
    }
  }
  
  // Now calculate recommendations for all nodes
  for (const nodeHash of allNodes) {
    const metrics = nodeMetrics.get(nodeHash)!;
    
    // Check if insufficient data
    if (metrics.edgePacketCount < MIN_PACKETS_FOR_TX_DELAY) {
      recommendations.set(nodeHash, {
        txDelayFactor: 0,
        directTxDelayFactor: 0,
        trafficIntensity: 0,
        directNeighborCount: metrics.directNeighborCount,
        collisionRisk: 0,
        confidence: 0,
        insufficientData: true,
        // Phase 6 defaults
        avgPathPosition: 0,
        pathPositionVariance: 0,
        floodParticipationRate: 0,
        pathDiversity: 0,
        positionDelayMs: 0,
      });
      continue;
    }
    
    // === PHASE 6: Calculate path position metrics ===
    // Find this node's prefix for path matching
    const nodePrefix = nodeHash.startsWith('0x')
      ? nodeHash.slice(2, 4).toUpperCase()
      : nodeHash.slice(0, 2).toUpperCase();
    
    // Track path positions where this node appears
    const positions: number[] = [];
    let floodPathCount = 0;
    let totalPathsWithNode = 0;
    
    for (const path of pathRegistry.paths) {
      // Check if this node appears in the path
      const posInPath = path.hops.findIndex(hop => hop.toUpperCase() === nodePrefix);
      if (posInPath >= 0) {
        // Position is 1-indexed from source (position 0 in hops = first relay)
        // Higher position = closer to destination
        positions.push(posInPath + 1);
        totalPathsWithNode++;
        if (path.routeType === 'flood') {
          floodPathCount++;
        }
      }
    }
    
    // Calculate position stats
    const avgPathPosition = positions.length > 0
      ? positions.reduce((a, b) => a + b, 0) / positions.length
      : 0;
    
    // Variance calculation
    let pathPositionVariance = 0;
    if (positions.length > 1) {
      const sumSquaredDiff = positions.reduce((sum, pos) => sum + Math.pow(pos - avgPathPosition, 2), 0);
      pathPositionVariance = sumSquaredDiff / positions.length;
    }
    
    const floodParticipationRate = totalPathsWithNode > 0
      ? floodPathCount / totalPathsWithNode
      : 0;
    
    const pathDiversity = totalPathsWithNode;
    
    // Traffic intensity: this node's edge packets / minute
    const trafficIntensity = timeSpanMinutes > 0 
      ? metrics.edgePacketCount / timeSpanMinutes 
      : 0;
    
    // Relative load factors (0-1, relative to busiest node with sufficient data)
    const relativeTraffic = maxEdgePacketCount > 0 
      ? metrics.edgePacketCount / maxEdgePacketCount 
      : 0;
    const relativeNeighbors = maxNeighborCount > 0 
      ? metrics.directNeighborCount / maxNeighborCount 
      : 0;
    const relativePaths = maxPathCount > 0 
      ? metrics.pathCount / maxPathCount 
      : 0;
    
    // Collision risk based on this node's actual metrics
    // Weight: neighbors (40%), traffic (35%), path centrality (25%)
    const collisionRisk = (
      relativeNeighbors * 0.40 + 
      relativeTraffic * 0.35 + 
      relativePaths * 0.25
    );
    
    // Calculate recommended tx_delay_factor
    // Base value varies with collision risk (continuous, not stepped)
    // Range: 0.7 (low risk) to 1.3 (high risk)
    let txDelayFactor = 0.7 + (collisionRisk * 0.6);
    
    // Additional adjustment for absolute neighbor count
    if (metrics.directNeighborCount >= 8) {
      txDelayFactor += 0.15;
    } else if (metrics.directNeighborCount >= 5) {
      txDelayFactor += 0.08;
    }
    
    // Clamp to reasonable range (0.5 - 1.5)
    txDelayFactor = Math.max(0.5, Math.min(1.5, txDelayFactor));
    
    // Round to 2 decimal places
    txDelayFactor = Math.round(txDelayFactor * 100) / 100;
    
    // Direct TX delay is typically 30-40% of flood delay
    const directTxDelayFactor = Math.round(txDelayFactor * 0.35 * 100) / 100;
    
    // Confidence based on edge validation strength for THIS node
    const validationConfidence = Math.min(metrics.avgEdgeValidation / 10, 1);
    const sampleConfidence = Math.min(packets.length / 500, 1);
    const confidence = Math.round((validationConfidence * 0.6 + sampleConfidence * 0.4) * 100) / 100;
    
    // Phase 6: Position-based delay adjustment
    // Nodes early in paths (position 1-2) need HIGHER delays (more collision potential)
    // Nodes later in paths can use lower delays
    let positionDelayMs = 0;
    if (avgPathPosition > 0) {
      if (avgPathPosition <= 1.5) {
        // First hop position - highest delay
        positionDelayMs = 50;
      } else if (avgPathPosition <= 2.5) {
        // Second hop
        positionDelayMs = 30;
      } else if (avgPathPosition <= 3.5) {
        // Third hop
        positionDelayMs = 15;
      }
      // Further hops get no additional delay
    }
    
    // Adjust txDelayFactor based on flood participation
    // High flood participation = needs conservative delays
    if (floodParticipationRate > 0.7) {
      txDelayFactor = Math.min(1.5, txDelayFactor + 0.1);
    }
    
    recommendations.set(nodeHash, {
      txDelayFactor,
      directTxDelayFactor,
      trafficIntensity: Math.round(trafficIntensity * 10) / 10,
      directNeighborCount: metrics.directNeighborCount,
      collisionRisk: Math.round(collisionRisk * 100) / 100,
      confidence,
      insufficientData: false,
      // Phase 6 metrics
      avgPathPosition: Math.round(avgPathPosition * 10) / 10,
      pathPositionVariance: Math.round(pathPositionVariance * 100) / 100,
      floodParticipationRate: Math.round(floodParticipationRate * 100) / 100,
      pathDiversity,
      positionDelayMs,
    });
  }
  
  return recommendations;
}

/**
 * Calculate edge betweenness centrality from observed paths.
 * 
 * Edge betweenness measures how often an edge appears in observed paths,
 * normalized to 0-1. Higher betweenness = more traffic flows through this edge.
 * 
 * This is a more accurate backbone detection than simply using top-N by count,
 * because it considers the actual routing patterns through the network.
 * 
 * **Observer Bias Correction (Symmetry Normalization):**
 * Edges with highly asymmetric traffic (one direction dominates) likely indicate
 * observer bias — we only see traffic flowing toward the local node. Symmetric
 * edges suggest genuine bidirectional traffic and are weighted higher.
 * 
 * The symmetry factor ranges from 0.5 (completely one-directional) to 1.0 (balanced).
 * This penalizes edges that appear important only because all observed traffic
 * flows through them toward the local observer.
 * 
 * @param pathRegistry - Registry of observed paths
 * @param edges - Topology edges to calculate betweenness for
 * @returns Map of edge key -> betweenness score (0-1)
 */
function calculateEdgeBetweenness(
  pathRegistry: PathRegistry,
  edges: TopologyEdge[]
): Map<string, number> {
  const betweenness = new Map<string, number>();
  
  // Build edge lookup for symmetry data
  const edgeByKey = new Map(edges.map(e => [e.key, e]));
  
  // Initialize all edges to 0
  for (const edge of edges) {
    betweenness.set(edge.key, 0);
  }
  
  if (pathRegistry.paths.length === 0) {
    return betweenness;
  }
  
  // For each observed path, increment betweenness of each edge
  // Weight by observation count (frequently seen paths contribute more)
  for (const path of pathRegistry.paths) {
    // Iterate consecutive pairs in the path
    for (let i = 0; i < path.hops.length - 1; i++) {
      const fromPrefix = path.hops[i];
      const toPrefix = path.hops[i + 1];
      
      // Find matching edges by comparing prefixes
      // Use simple prefix matching since paths store 2-char prefixes
      for (const edge of edges) {
        const edgeFromPrefix = getHashPrefix(edge.fromHash);
        const edgeToPrefix = getHashPrefix(edge.toHash);
        
        // Check if this edge matches the path hop (either direction)
        const matches = (
          (edgeFromPrefix === fromPrefix && edgeToPrefix === toPrefix) ||
          (edgeFromPrefix === toPrefix && edgeToPrefix === fromPrefix)
        );
        
        if (matches) {
          const current = betweenness.get(edge.key) || 0;
          betweenness.set(edge.key, current + path.observationCount);
          break; // Only count once per hop
        }
      }
    }
  }
  
  // Normalize to 0-1
  const maxBetweenness = Math.max(...betweenness.values(), 1);
  for (const [key, value] of betweenness) {
    betweenness.set(key, value / maxBetweenness);
  }
  
  // ╔═══════════════════════════════════════════════════════════════════════════╗
  // ║ OBSERVER BIAS CORRECTION: Symmetry Normalization                          ║
  // ╠═══════════════════════════════════════════════════════════════════════════╣
  // ║ Problem: All observed paths terminate at the local node, inflating        ║
  // ║ betweenness of edges near local. Edges with one-way traffic likely        ║
  // ║ reflect this observer bias rather than true network importance.           ║
  // ║                                                                           ║
  // ║ Solution: Penalize asymmetric edges using symmetryRatio from Phase 1.     ║
  // ║ Symmetric edges (bidirectional traffic) are more likely genuine backbone. ║
  // ║                                                                           ║
  // ║ Formula: symmetryFactor = 0.5 + 0.5 × symmetryRatio                       ║
  // ║   - Perfectly symmetric (ratio=1.0): factor=1.0, no penalty               ║
  // ║   - Completely one-way (ratio=0.0): factor=0.5, 50% penalty               ║
  // ║   - Mostly one-way (ratio=0.3): factor=0.65, 35% penalty                  ║
  // ║                                                                           ║
  // ║ TODO: Additional observer bias corrections to consider:                   ║
  // ║   1. Hop-distance weighting: discount edges by distance from local        ║
  // ║   2. Local-exclusion: exclude local-adjacent edges from backbone ID       ║
  // ║   3. Cross-node aggregation: combine topology from multiple observers     ║
  // ║                                                                           ║
  // ║ @see https://github.com/rightup/pymc_console - Observer Bias Discussion   ║
  // ╚═══════════════════════════════════════════════════════════════════════════╝
  for (const [key, rawScore] of betweenness) {
    const edge = edgeByKey.get(key);
    if (edge) {
      const symmetryFactor = 0.5 + 0.5 * edge.symmetryRatio;
      betweenness.set(key, rawScore * symmetryFactor);
    }
  }
  
  return betweenness;
}

/**
 * Identify backbone edges based on betweenness centrality.
 * 
 * Backbone edges are the most critical links in the network,
 * carrying the highest proportion of traffic.
 * 
 * @param edgeBetweenness - Edge betweenness scores
 * @param topN - Number of top edges to return (default 3)
 * @param minBetweenness - Minimum betweenness to qualify (default 0.3)
 * @returns Array of edge keys for backbone edges
 */
function identifyBackboneEdges(
  edgeBetweenness: Map<string, number>,
  topN: number = 3,
  minBetweenness: number = 0.3
): string[] {
  // Sort edges by betweenness descending
  const sorted = [...edgeBetweenness.entries()]
    .filter(([, betweenness]) => betweenness >= minBetweenness)
    .sort((a, b) => b[1] - a[1]);
  
  // Return top N
  return sorted.slice(0, topN).map(([key]) => key);
}

/**
 * Calculate node mobility metrics based on path appearance patterns.
 * 
 * Mobile nodes tend to:
 * - Appear and disappear from paths frequently
 * - Have short-lived path memberships
 * - Show high volatility in their routing participation
 * 
 * @param pathRegistry - Registry of observed paths
 * @param neighbors - Known neighbors for hash lookup
 * @returns Map of node hash -> NodeMobility
 */
function calculateNodeMobility(
  pathRegistry: PathRegistry,
  neighbors: Record<string, NeighborInfo>
): { nodeMobility: Map<string, NodeMobility>; mobileNodes: string[] } {
  const nodeMobility = new Map<string, NodeMobility>();
  const mobileNodes: string[] = [];
  
  if (pathRegistry.paths.length === 0) {
    return { nodeMobility, mobileNodes };
  }
  
  // Group paths by time windows (1 hour windows)
  const WINDOW_SIZE_MS = 60 * 60 * 1000; // 1 hour
  const timestamps = pathRegistry.paths.map(p => p.lastSeen).sort((a, b) => a - b);
  const minTime = timestamps[0];
  const maxTime = timestamps[timestamps.length - 1];
  const numWindows = Math.ceil((maxTime - minTime) / WINDOW_SIZE_MS) || 1;
  
  // Track per-node statistics
  const nodeStats = new Map<string, {
    paths: Set<string>;
    firstSeen: number;
    lastSeen: number;
    windowPresence: Set<number>; // Which time windows the node appeared in
  }>();
  
  // Process all paths to gather per-node stats
  for (const path of pathRegistry.paths) {
    const windowIndex = Math.floor((path.lastSeen - minTime) / WINDOW_SIZE_MS);
    
    // Track each hop in the path
    for (const prefix of path.hops) {
      // Find matching neighbor by prefix
      let nodeHash = prefix; // Default to prefix if no match
      for (const [hash] of Object.entries(neighbors)) {
        const neighborPrefix = hash.startsWith('0x') 
          ? hash.slice(2, 4).toUpperCase()
          : hash.slice(0, 2).toUpperCase();
        if (neighborPrefix === prefix.toUpperCase()) {
          nodeHash = hash;
          break;
        }
      }
      
      let stats = nodeStats.get(nodeHash);
      if (!stats) {
        stats = {
          paths: new Set(),
          firstSeen: path.firstSeen,
          lastSeen: path.lastSeen,
          windowPresence: new Set(),
        };
        nodeStats.set(nodeHash, stats);
      }
      
      stats.paths.add(path.id);
      stats.firstSeen = Math.min(stats.firstSeen, path.firstSeen);
      stats.lastSeen = Math.max(stats.lastSeen, path.lastSeen);
      stats.windowPresence.add(windowIndex);
    }
  }
  
  // Calculate mobility metrics for each node
  for (const [hash, stats] of nodeStats) {
    const pathDiversity = stats.paths.size;
    const lifespanMs = stats.lastSeen - stats.firstSeen;
    const avgPathLifespanHours = lifespanMs > 0 ? lifespanMs / (1000 * 60 * 60) : 0;
    const activeWindowRatio = numWindows > 0 ? stats.windowPresence.size / numWindows : 1;
    
    // Volatility: lower active window ratio = more volatile (appears/disappears)
    // Also consider path diversity: more diverse paths = less volatile (consistently relaying)
    // Formula: high volatility if (low activeWindowRatio AND low pathDiversity)
    const windowVolatility = 1 - activeWindowRatio;
    const diversityFactor = Math.min(pathDiversity / 10, 1); // Cap at 10 paths
    const pathVolatility = windowVolatility * (1 - diversityFactor * 0.5);
    
    const isMobile = pathVolatility > 0.3;
    
    const mobility: NodeMobility = {
      hash,
      pathVolatility,
      pathDiversity,
      avgPathLifespanHours,
      isMobile,
      lastSeen: stats.lastSeen,
      activeWindowRatio,
    };
    
    nodeMobility.set(hash, mobility);
    
    if (isMobile) {
      mobileNodes.push(hash);
    }
  }
  
  // Sort mobile nodes by volatility (most volatile first)
  mobileNodes.sort((a, b) => {
    const aVol = nodeMobility.get(a)?.pathVolatility ?? 0;
    const bVol = nodeMobility.get(b)?.pathVolatility ?? 0;
    return bVol - aVol;
  });
  
  return { nodeMobility, mobileNodes };
}

/**
 * Calculate health metrics for the top observed paths.
 * 
 * Path health is determined by:
 * - Edge certainty (how well-validated each link is)
 * - Observation recency (recently seen paths are healthier)
 * - Observation trend (increasing vs declining usage)
 * - Alternate paths (redundancy improves reliability)
 * 
 * @param pathRegistry - Registry of observed paths
 * @param edges - Topology edges for certainty lookup
 * @param hubNodes - Hub nodes for hub involvement detection
 * @param topN - Number of top paths to analyze (default 20)
 * @returns Array of PathHealth sorted by health score descending
 */
function calculatePathHealth(
  pathRegistry: PathRegistry,
  edges: TopologyEdge[],
  hubNodes: string[],
  topN: number = 20
): PathHealth[] {
  const pathHealth: PathHealth[] = [];
  
  if (pathRegistry.paths.length === 0) {
    return pathHealth;
  }
  
  // Build edge lookup by prefix pairs
  const edgeByPrefix = new Map<string, TopologyEdge>();
  for (const edge of edges) {
    const fromPrefix = getHashPrefix(edge.fromHash);
    const toPrefix = getHashPrefix(edge.toHash);
    // Store both directions
    edgeByPrefix.set(`${fromPrefix}>${toPrefix}`, edge);
    edgeByPrefix.set(`${toPrefix}>${fromPrefix}`, edge);
  }
  
  // Build hub prefix set for quick lookup
  const hubPrefixes = new Set<string>();
  for (const hubHash of hubNodes) {
    hubPrefixes.add(getHashPrefix(hubHash));
  }
  
  // Group paths by destination (last hop) for alternate path counting
  const pathsByDest = new Map<string, string[]>();
  for (const path of pathRegistry.paths) {
    if (path.hops.length === 0) continue;
    const dest = path.hops[path.hops.length - 1];
    const existing = pathsByDest.get(dest) || [];
    existing.push(path.id);
    pathsByDest.set(dest, existing);
  }
  
  // Sort paths by observation count (descending) to get top paths
  const sortedPaths = [...pathRegistry.paths].sort(
    (a, b) => b.observationCount - a.observationCount
  );
  
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  
  // Calculate health for top paths
  for (const path of sortedPaths.slice(0, topN)) {
    if (path.hops.length < 2) continue; // Need at least one edge
    
    // Find edge certainties along this path
    let totalCertainty = 0;
    let weakestCertainty = Infinity;
    let weakestLinkKey: string | null = null;
    let edgeCount = 0;
    let involvesHub = false;
    
    for (let i = 0; i < path.hops.length - 1; i++) {
      const fromPrefix = path.hops[i];
      const toPrefix = path.hops[i + 1];
      const edgeLookupKey = `${fromPrefix}>${toPrefix}`;
      const edge = edgeByPrefix.get(edgeLookupKey);
      
      if (edge) {
        // Certainty as ratio of certain observations to total
        const edgeCertainty = edge.packetCount > 0 
          ? edge.certainCount / edge.packetCount 
          : 0;
        totalCertainty += edgeCertainty;
        edgeCount++;
        
        if (edgeCertainty < weakestCertainty) {
          weakestCertainty = edgeCertainty;
          weakestLinkKey = edge.key;
        }
      } else {
        // Unknown edge = low certainty
        totalCertainty += 0.1;
        edgeCount++;
        if (0.1 < weakestCertainty) {
          weakestCertainty = 0.1;
          weakestLinkKey = makeEdgeKey(fromPrefix, toPrefix);
        }
      }
      
      // Check for hub involvement
      if (hubPrefixes.has(fromPrefix) || hubPrefixes.has(toPrefix)) {
        involvesHub = true;
      }
    }
    
    const avgEdgeCertainty = edgeCount > 0 ? totalCertainty / edgeCount : 0;
    const weakestLinkConfidence = weakestCertainty === Infinity ? 0 : weakestCertainty;
    
    // Observation trend: compare first half vs second half of observation timestamps
    // Positive = increasing, negative = declining
    const ageHours = (now - path.lastSeen) / ONE_HOUR_MS;
    const recencyScore = Math.exp(-ageHours / 24); // Decay over 24 hours
    
    // Simple trend: if recently seen and has many observations, trend is positive
    const observationTrend = path.observationCount > 10 && ageHours < 12
      ? 0.5 + (1 - ageHours / 12) * 0.5  // Positive trend
      : ageHours > 48 
        ? -0.5 // Declining
        : 0;   // Neutral
    
    // Alternate paths to same destination
    const dest = path.hops[path.hops.length - 1];
    const alternates = pathsByDest.get(dest) || [];
    const alternatePathsCount = Math.max(0, alternates.length - 1); // Exclude self
    
    // Estimated latency: ~30ms per hop for flood, ~20ms for direct
    const baseLatencyPerHop = path.routeType === 'direct' ? 20 : 30;
    const estimatedLatencyMs = path.hops.length * baseLatencyPerHop;
    
    // Health score calculation
    // Factors: edge certainty (40%), recency (30%), trend (15%), alternates (15%)
    const certaintyFactor = avgEdgeCertainty * 0.4;
    const recencyFactor = recencyScore * 0.3;
    const trendFactor = ((observationTrend + 1) / 2) * 0.15; // Normalize -1..1 to 0..1
    const alternateFactor = Math.min(alternatePathsCount / 3, 1) * 0.15; // Cap at 3 alternates
    
    const healthScore = Math.round(
      (certaintyFactor + recencyFactor + trendFactor + alternateFactor) * 100
    ) / 100;
    
    pathHealth.push({
      pathKey: path.id,
      hops: [...path.hops],
      healthScore,
      weakestLinkKey,
      weakestLinkConfidence: Math.round(weakestLinkConfidence * 100) / 100,
      avgEdgeCertainty: Math.round(avgEdgeCertainty * 100) / 100,
      observationTrend: Math.round(observationTrend * 100) / 100,
      alternatePathsCount,
      estimatedLatencyMs,
      observationCount: path.observationCount,
      routeType: path.routeType === 'unknown' ? 'mixed' : path.routeType,
      lastSeen: path.lastSeen,
      involvesHub,
    });
  }
  
  // Sort by health score descending
  pathHealth.sort((a, b) => b.healthScore - a.healthScore);
  
  return pathHealth;
}

// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║ MAIN ENTRY POINT: buildMeshTopology()                                         ║
// ╠═══════════════════════════════════════════════════════════════════════════════╣
// ║ This is the primary function that orchestrates all topology analysis.         ║
// ║ It is computationally expensive and should be run in a Web Worker.            ║
// ║                                                                               ║
// ║ Execution order:                                                              ║
// ║   1. Build prefix disambiguation lookup                                       ║
// ║   2. Build neighbor affinity map                                              ║
// ║   3. Accumulate edge observations from packet paths                           ║
// ║   4. Calculate node centrality                                                ║
// ║   5. Convert accumulators to edges                                            ║
// ║   6. Run loop detection                                                       ║
// ║   7. Build path registry (Phase 2)                                            ║
// ║   8. Calculate TX delays (Phase 6)                                            ║
// ║   9. Calculate edge betweenness (Phase 4)                                     ║
// ║  10. Detect mobile nodes (Phase 5)                                            ║
// ║  11. Calculate path health (Phase 7)                                          ║
// ║                                                                               ║
// ║ NOTE: Phase numbers are historical and don't reflect execution order.         ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝
/**
 * Analyze packets to build mesh topology with confidence-weighted edges.
 * 
 * TOPOLOGY PRINCIPLES:
 * - Paths represent the forwarding chain: [A, B, C, local] means A→B→C→local
 * - Consecutive pairs in paths represent actual RF links (edges)
 * - We build edges ONLY from consecutive path pairs, NOT from assumptions
 * - Betweenness centrality identifies hub nodes (high-traffic forwarders)
 * - Hop distance from local calculated by shortest path through the graph
 * 
 * @param packets - All packets to analyze
 * @param neighbors - Known neighbors with location data
 * @param localHash - Local node's hash
 * @param confidenceThreshold - Minimum per-hop confidence to include (default 0.5)
 * @param localLat - Local node latitude (for proximity calculations)
 * @param localLon - Local node longitude (for proximity calculations)
 * @returns MeshTopology with edges, centrality, and hub nodes
 */
export function buildMeshTopology(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  confidenceThreshold: number = 0.5, // Lower threshold to capture more topology
  localLat?: number,
  localLon?: number
): MeshTopology {
  // IMPORTANT: Sort packets by timestamp for deterministic processing
  // This ensures the same packet data produces the same topology regardless of fetch order
  const sortedPackets = [...packets].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  
  // === BUILD PREFIX DISAMBIGUATION LOOKUP ===
  // This is the centralized system that resolves 2-char prefix collisions
  // using position consistency, co-occurrence patterns, and geographic proximity
  const prefixLookup = buildPrefixLookup(sortedPackets, neighbors, localHash, localLat, localLon);
  
  // Log disambiguation stats in development
  if (process.env.NODE_ENV === 'development') {
    const disambigStats = getDisambiguationStats(prefixLookup);
    console.log('[mesh-topology] Disambiguation stats:', disambigStats);
  }
  
  // First pass: build neighbor affinity map with proximity scores (for backward compat)
  const neighborAffinity = buildNeighborAffinity(sortedPackets, neighbors, localLat, localLon, localHash);
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  
  // Convert to simple number map for backward compatibility in return value
  const simpleAffinity = new Map<string, number>();
  for (const [hash, aff] of neighborAffinity) {
    simpleAffinity.set(hash, aff.combinedScore);
  }
  
  // Accumulate edge observations from consecutive path pairs
  const accumulators = new Map<string, EdgeAccumulator>();
  
  // Track node appearances for centrality calculation
  const nodePathCounts = new Map<string, number>(); // How many paths include this node
  const nodeBridgeCounts = new Map<string, number>(); // How many times node is in middle of path
  const nodeGatewayCounts = new Map<string, number>(); // How many times node is at position 1 (last hop to local)
  
  // === LAST-HOP NEIGHBOR TRACKING ===
  // Track all prefixes that appear as last hop with signal quality data
  // This is ground truth: these are nodes that forwarded packets directly to us
  interface LastHopPrefixAccumulator {
    prefix: string;
    count: number;
    rssiSum: number;
    rssiCount: number;  // Count of valid RSSI values
    snrSum: number;
    snrCount: number;   // Count of valid SNR values
    lastSeen: number;
    // Track which full hashes this prefix resolved to (with confidence)
    resolvedHashes: Map<string, { count: number; confidenceSum: number }>;
  }
  const lastHopPrefixData = new Map<string, LastHopPrefixAccumulator>();
  
  // Current time for recency calculations (compute once per topology build)
  const nowTimestamp = Math.floor(Date.now() / 1000);
  
  // Recency decay constant (12-hour half-life, consistent with prefix-disambiguation.ts)
  const RECENCY_DECAY_HOURS = 12;
  
  /**
   * Calculate recency score for a packet timestamp.
   * Uses exponential decay: score = e^(-hours/12)
   * Returns 0.1 for missing/invalid timestamps.
   */
  const calculateRecencyScore = (timestamp: number | undefined): number => {
    if (!timestamp || timestamp <= 0) return 0.1;
    const hoursAgo = (nowTimestamp - timestamp) / 3600;
    if (hoursAgo < 0) return 1.0; // Future timestamp (clock skew)
    return Math.exp(-hoursAgo / RECENCY_DECAY_HOURS);
  };
  
  // Helper to add/update edge accumulator
  // actualFrom/actualTo represent the real direction of traffic flow (for directional tracking)
  // routeType: 0=flood, 1=direct, 2=transport, undefined=unknown
  // packetTimestamp: unix timestamp (seconds) of the packet for recency scoring
  const addEdgeObservation = (
    actualFrom: string,
    actualTo: string,
    hopConfidence: number,
    isCertain: boolean,
    hopDistanceFromLocal: number,
    routeType?: number,
    packetTimestamp?: number
  ) => {
    // Edge key is always sorted for consistent lookup (bidirectional edge)
    const key = makeEdgeKey(actualFrom, actualTo);
    const existing = accumulators.get(key);
    
    // Determine canonical direction (fromHash is always the "smaller" hash alphabetically)
    // This ensures we can track forward vs reverse consistently
    const [canonicalFrom, canonicalTo] = actualFrom < actualTo 
      ? [actualFrom, actualTo] 
      : [actualTo, actualFrom];
    const isForward = actualFrom === canonicalFrom; // Traffic matches canonical direction
    
    // Determine if this is flood or direct routed
    const isFlood = routeType === 0 || routeType === undefined; // Default to flood if unknown
    const isDirect = routeType === 1;
    
    // Calculate recency score for this observation
    const recencyScore = calculateRecencyScore(packetTimestamp);
    
    if (existing) {
      existing.count++;
      existing.confidenceSum += hopConfidence;
      existing.recencySum += recencyScore;
      existing.minHopDistance = Math.min(existing.minHopDistance, hopDistanceFromLocal);
      if (hopDistanceFromLocal < existing.hopDistanceCounts.length) {
        existing.hopDistanceCounts[hopDistanceFromLocal]++;
      }
      if (isCertain) {
        existing.certainCount++;
      } else {
        existing.uncertainCount++;
      }
      // Track direction
      if (isForward) {
        existing.forwardCount++;
      } else {
        existing.reverseCount++;
      }
      // Track route type
      if (isFlood) {
        existing.floodCount++;
      } else if (isDirect) {
        existing.directCount++;
      }
    } else {
      const hopCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      if (hopDistanceFromLocal < hopCounts.length) {
        hopCounts[hopDistanceFromLocal]++;
      }
      accumulators.set(key, {
        fromHash: canonicalFrom,
        toHash: canonicalTo,
        key,
        count: 1,
        confidenceSum: hopConfidence,
        minHopDistance: hopDistanceFromLocal,
        hopDistanceCounts: hopCounts,
        certainCount: isCertain ? 1 : 0,
        uncertainCount: isCertain ? 0 : 1,
        forwardCount: isForward ? 1 : 0,
        reverseCount: isForward ? 0 : 1,
        floodCount: isFlood ? 1 : 0,
        directCount: isDirect ? 1 : 0,
        recencySum: recencyScore,
      });
    }
  };
  
  for (const packet of sortedPackets) {
    // Use centralized path parsing from path-utils.ts
    const parsed = parsePacketPath(packet, localHash);
    if (!parsed) continue;
    
    const effectivePath = parsed.effective; // Local already stripped
    const effectiveLength = parsed.effectiveLength;
    const originalPath = parsed.original; // For source->first-hop inference
    
    // Track which nodes appear in this path (for centrality)
    const nodesInPath = new Set<string>();
    
    // === SOURCE → FIRST HOP INFERENCE (ALL PACKET TYPES) ===
    // For any packet with src_hash, we can infer an edge from the source to the first hop
    // This reveals the source's direct RF neighbor on their side of the network
    if (packet.src_hash && originalPath.length >= 1) {
      const firstHopPrefix = originalPath[0];
      
      // Resolve the first hop using disambiguation system
      // Position for first hop is effectiveLength (furthest from local)
      const firstHopResult = resolvePrefix(prefixLookup, firstHopPrefix, {
        position: effectiveLength, // Furthest from local
        adjacentPrefixes: originalPath.length > 1 ? [originalPath[1]] : [],
      });
      
      // The source hash is known exactly (from the packet)
      const srcHash = packet.src_hash;
      
      if (firstHopResult.hash && firstHopResult.hash !== srcHash) {
        // Use disambiguation confidence for certainty
        const srcInNeighbors = Object.keys(neighbors).includes(srcHash);
        const isCertain = firstHopResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD && srcInNeighbors;
        const confidence = firstHopResult.confidence * (srcInNeighbors ? 1 : 0.8);
        
        // This edge is at the FAR end of the path from local's perspective
        const hopDistance = effectiveLength + 1; // Beyond the effective path
        
        // Get route type: prefer 'route' (SQLite API), fallback to 'route_type'
        const routeType = packet.route ?? packet.route_type;
        addEdgeObservation(srcHash, firstHopResult.hash, confidence, isCertain, hopDistance, routeType, packet.timestamp);
        
        // Track for centrality
        nodesInPath.add(srcHash);
        nodesInPath.add(firstHopResult.hash);
      }
    }
    
    // === LAST HOP → LOCAL INFERENCE (ALL PACKET TYPES) ===
    // The last forwarder is the node that sent us the packet directly.
    // This is position 1 in the effective path (already has local stripped)
    if (localHash && effectiveLength >= 1) {
      const lastHopIndex = effectiveLength - 1;
      const lastHopPrefix = effectivePath[lastHopIndex];
      
      // === TRACK LAST-HOP PREFIX DATA (before disambiguation) ===
      // This captures ALL prefixes that appear as last hop, with signal quality
      // The prefix is ground truth; disambiguation resolves which node it is
      const existingPrefixData = lastHopPrefixData.get(lastHopPrefix);
      if (existingPrefixData) {
        existingPrefixData.count++;
        if (typeof packet.rssi === 'number' && !isNaN(packet.rssi)) {
          existingPrefixData.rssiSum += packet.rssi;
          existingPrefixData.rssiCount++;
        }
        if (typeof packet.snr === 'number' && !isNaN(packet.snr)) {
          existingPrefixData.snrSum += packet.snr;
          existingPrefixData.snrCount++;
        }
        existingPrefixData.lastSeen = Math.max(existingPrefixData.lastSeen, packet.timestamp ?? 0);
      } else {
        lastHopPrefixData.set(lastHopPrefix, {
          prefix: lastHopPrefix,
          count: 1,
          rssiSum: typeof packet.rssi === 'number' && !isNaN(packet.rssi) ? packet.rssi : 0,
          rssiCount: typeof packet.rssi === 'number' && !isNaN(packet.rssi) ? 1 : 0,
          snrSum: typeof packet.snr === 'number' && !isNaN(packet.snr) ? packet.snr : 0,
          snrCount: typeof packet.snr === 'number' && !isNaN(packet.snr) ? 1 : 0,
          lastSeen: packet.timestamp ?? 0,
          resolvedHashes: new Map(),
        });
      }
      
      // Resolve the last hop using disambiguation system
      // Position 1 = last forwarder (closest to local)
      const lastHopResult = resolvePrefix(prefixLookup, lastHopPrefix, {
        position: 1, // Last forwarder is always position 1
        adjacentPrefixes: lastHopIndex > 0 ? [effectivePath[lastHopIndex - 1]] : [],
        isLastHop: true,
      });
      
      // Track which hash this prefix resolved to (for later aggregation)
      if (lastHopResult.hash) {
        const prefixData = lastHopPrefixData.get(lastHopPrefix)!;
        const existingHashData = prefixData.resolvedHashes.get(lastHopResult.hash);
        if (existingHashData) {
          existingHashData.count++;
          existingHashData.confidenceSum += lastHopResult.confidence;
        } else {
          prefixData.resolvedHashes.set(lastHopResult.hash, {
            count: 1,
            confidenceSum: lastHopResult.confidence,
          });
        }
      }
      
      if (lastHopResult.hash && lastHopResult.hash !== localHash) {
        // This edge touches local directly - hop distance = 0
        //
        // ALWAYS mark last-hop-to-local as certain because we definitively received
        // the packet from SOMEONE. The disambiguation system picks the most likely
        // candidate, and we trust that resolution. This is critical for setups where
        // an observer receives through a single gateway with prefix collisions.
        const isCertain = true;
        const confidence = lastHopResult.confidence;
        
        // Get route type: prefer 'route' (SQLite API), fallback to 'route_type'
        const routeType = packet.route ?? packet.route_type;
        addEdgeObservation(lastHopResult.hash, localHash, confidence, isCertain, 0, routeType, packet.timestamp);
        
        // Track for centrality
        nodesInPath.add(lastHopResult.hash);
        nodesInPath.add(localHash);
        
        // Track gateway count (node at position 1 = last hop to local)
        // This is used for "gateway hub" detection - nodes that forward lots of traffic
        // directly to local but don't appear in the middle of paths
        nodeGatewayCounts.set(lastHopResult.hash, (nodeGatewayCounts.get(lastHopResult.hash) || 0) + 1);
      }
    }
    
    // Process consecutive pairs
    for (let i = 0; i < effectiveLength - 1; i++) {
      const fromPrefix = effectivePath[i];
      const toPrefix = effectivePath[i + 1];
      
      // Calculate positions using centralized helper
      const fromPosition = getPositionFromIndex(i, effectiveLength);
      const toPosition = getPositionFromIndex(i + 1, effectiveLength);
      const isToLastHop = toPosition === 1;
      
      // Resolve both ends using disambiguation system with context
      const fromResult = resolvePrefix(prefixLookup, fromPrefix, {
        position: fromPosition,
        adjacentPrefixes: [
          ...(i > 0 ? [effectivePath[i - 1]] : []),
          effectivePath[i + 1],
        ],
      });
      
      const toResult = resolvePrefix(prefixLookup, toPrefix, {
        position: toPosition,
        adjacentPrefixes: [
          effectivePath[i],
          ...(i + 2 < effectiveLength ? [effectivePath[i + 2]] : []),
        ],
        isLastHop: isToLastHop,
      });
      
      // Skip if either end couldn't be resolved
      if (!fromResult.hash || !toResult.hash) continue;
      
      // Skip self-loops
      if (fromResult.hash === toResult.hash) continue;
      
      // Determine if this observation is "certain" based on disambiguation confidence
      // 
      // IMPORTANT FIX: An observation should be certain if EITHER:
      // 1. Both endpoints have high confidence (traditional case)
      // 2. The "to" node has very high confidence (>= 0.9) - this handles the case where
      //    a high-confidence gateway (like node 24) receives from nodes with collisions.
      //    We KNOW the packet went through the gateway, so the edge is certain even if
      //    we're less sure about the exact upstream node.
      // 3. This is the last hop in the path (toPosition === 1) and to has high confidence
      //
      // This allows us to build edges backward from confidently-resolved gateways.
      const bothHighConfidence = 
        fromResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD && 
        toResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD;
      const toIsVeryHighConfidence = toResult.confidence >= 0.9;
      const toIsConfidentLastHop = isToLastHop && toResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD;
      
      const isCertainObservation = bothHighConfidence || toIsVeryHighConfidence || toIsConfidentLastHop;
      
      // Track nodes for centrality
      nodesInPath.add(fromResult.hash);
      nodesInPath.add(toResult.hash);
      
      // Track bridge nodes (middle of path = not first or last in effective path)
      if (i > 0 && i < effectiveLength - 1) {
        nodeBridgeCounts.set(fromResult.hash, (nodeBridgeCounts.get(fromResult.hash) || 0) + 1);
      }
      
      // Calculate combined confidence for this hop
      // When to-node is very high confidence, use its confidence directly
      // (don't penalize by multiplying with from's lower confidence)
      const hopConfidence = toIsVeryHighConfidence 
        ? toResult.confidence 
        : fromResult.confidence * toResult.confidence;
      
      // For uncertain edges, apply threshold; certain edges always included
      if (!isCertainObservation && hopConfidence < confidenceThreshold) continue;
      
      // Calculate hop distance from local using centralized helper
      const hopDistanceFromLocal = getHopDistanceFromLocal(toPosition);
      
      // Add edge observation using helper
      // Get route type: prefer 'route' (SQLite API), fallback to 'route_type'
      const routeType = packet.route ?? packet.route_type;
      addEdgeObservation(
        fromResult.hash,
        toResult.hash,
        hopConfidence,
        isCertainObservation,
        hopDistanceFromLocal,
        routeType,
        packet.timestamp
      );
    }
    
    // Update path counts for centrality
    for (const nodeHash of nodesInPath) {
      nodePathCounts.set(nodeHash, (nodePathCounts.get(nodeHash) || 0) + 1);
    }
  }
  
  // Calculate betweenness centrality (simplified: bridge count / path count)
  const centrality = new Map<string, number>();
  let maxCentrality = 0;
  
  for (const [hash, pathCount] of nodePathCounts) {
    const bridgeCount = nodeBridgeCounts.get(hash) || 0;
    // Centrality = how often this node is in the middle of paths relative to total appearances
    const centralityScore = pathCount > 0 ? bridgeCount / pathCount : 0;
    centrality.set(hash, centralityScore);
    maxCentrality = Math.max(maxCentrality, centralityScore);
  }
  
  // Normalize centrality scores
  if (maxCentrality > 0) {
    for (const [hash, score] of centrality) {
      centrality.set(hash, score / maxCentrality);
    }
  }
  
  // Identify hub nodes using TWO criteria:
  // 1. Bridge hubs: nodes that appear in the MIDDLE of many paths (high betweenness centrality)
  // 2. Gateway hubs: nodes at position 1 (last hop to local) with high traffic volume
  //
  // The second criterion fixes a bug where gateway nodes that forward lots of traffic
  // to local but never appear in the middle of paths were not identified as hubs.
  const minPathsForHub = Math.max(MIN_EDGE_VALIDATIONS, Math.floor(packets.length * 0.01)); // At least 3 or 1% of packets
  const hubNodesSet = new Set<string>();
  
  // === BRIDGE HUBS: High betweenness centrality ===
  const sortedByCentrality = [...centrality.entries()]
    .filter(([hash, _]) => (nodePathCounts.get(hash) || 0) >= minPathsForHub)
    .sort((a, b) => b[1] - a[1]);
  
  // Take nodes with centrality >= 0.5 (normalized) as bridge hubs
  for (const [hash, score] of sortedByCentrality) {
    if (score >= 0.5) {
      hubNodesSet.add(hash);
    }
  }
  
  // === GATEWAY HUBS: High traffic at position 1 (last hop to local) ===
  // These nodes may have zero bridge count (never in middle of paths) but still
  // forward significant traffic directly to the local node.
  //
  // Gateway hub threshold: forwarded at least 5% of all packets as last hop
  // OR forwarded at least 100 packets as last hop (whichever is lower)
  const minGatewayPackets = Math.min(100, Math.floor(packets.length * 0.05));
  const maxGatewayCount = Math.max(...nodeGatewayCounts.values(), 1);
  
  for (const [hash, gatewayCount] of nodeGatewayCounts) {
    // Skip local node
    if (hash === localHash) continue;
    
    // Already identified as a bridge hub
    if (hubNodesSet.has(hash)) continue;
    
    // Gateway hub if:
    // 1. Forwarded significant traffic as last hop, OR
    // 2. Is the dominant gateway (handles >50% of last-hop traffic)
    const gatewayRatio = gatewayCount / maxGatewayCount;
    if (gatewayCount >= minGatewayPackets || gatewayRatio >= 0.5) {
      hubNodesSet.add(hash);
      // Also set centrality for gateway hubs based on gateway traffic share
      // This ensures they appear properly in centrality-based UI elements
      const gatewayCentrality = gatewayCount / (nodePathCounts.get(hash) || gatewayCount);
      const existingCentrality = centrality.get(hash) || 0;
      centrality.set(hash, Math.max(existingCentrality, gatewayCentrality));
    }
  }
  
  const hubNodes = Array.from(hubNodesSet);
  
  // Convert accumulators to edges
  // Only include edges with MIN_EDGE_VALIDATIONS (5+) certain observations
  const edges: TopologyEdge[] = [];
  const validatedEdges: TopologyEdge[] = [];
  const weakEdges: TopologyEdge[] = [];
  let maxPacketCount = 0;
  let maxCertainCount = 0;
  const hubSet = new Set(hubNodes);
  
  // Build set of validated edge keys to avoid duplicates in weak edges
  const validatedEdgeKeys = new Set<string>();
  
  for (const acc of accumulators.values()) {
    const avgConfidence = acc.confidenceSum / acc.count;
    maxPacketCount = Math.max(maxPacketCount, acc.count);
    maxCertainCount = Math.max(maxCertainCount, acc.certainCount);
    
    // Check if either end is a hub node
    const isHubConnection = hubSet.has(acc.fromHash) || hubSet.has(acc.toHash);
    
    // An edge meets the validation threshold if it has 5+ certain observations
    const meetsThreshold = acc.certainCount >= MIN_EDGE_VALIDATIONS;
    
    // Calculate directional metrics
    // Symmetry ratio: 0 = completely one-directional, 1 = perfectly symmetric
    const totalDirectional = acc.forwardCount + acc.reverseCount;
    const symmetryRatio = totalDirectional > 0 
      ? Math.min(acc.forwardCount, acc.reverseCount) / Math.max(acc.forwardCount, acc.reverseCount)
      : 0;
    
    // Dominant direction: which way most packets flow
    // 'forward' = fromHash→toHash, 'reverse' = toHash→fromHash, 'balanced' = symmetric
    let dominantDirection: 'forward' | 'reverse' | 'balanced' = 'balanced';
    if (symmetryRatio < 0.7 && totalDirectional > 0) {
      dominantDirection = acc.forwardCount > acc.reverseCount ? 'forward' : 'reverse';
    }
    
    // Is this primarily a direct-routed edge? (ground truth from MeshCore)
    const totalRouteCounts = acc.floodCount + acc.directCount;
    const isDirectPathEdge = totalRouteCounts > 0 && acc.directCount > acc.floodCount;
    
    // Calculate average recency for this edge (0-1, higher = more recent observations)
    const avgRecency = acc.count > 0 ? acc.recencySum / acc.count : 0;
    
    const edge: TopologyEdge = {
      fromHash: acc.fromHash,
      toHash: acc.toHash,
      key: acc.key,
      packetCount: acc.count,
      avgConfidence,
      strength: 0, // Will be calculated below
      avgRecency,
      hopDistanceFromLocal: acc.minHopDistance,
      isHubConnection,
      isCertain: meetsThreshold, // Now means "meets validation threshold"
      certainCount: acc.certainCount,
      // Phase 1: Directional tracking
      forwardCount: acc.forwardCount,
      reverseCount: acc.reverseCount,
      symmetryRatio,
      dominantDirection,
      // Phase 3: Flood vs Direct detection
      floodCount: acc.floodCount,
      directCount: acc.directCount,
      isDirectPathEdge,
    };
    
    edges.push(edge);
    
    // Only include edges that meet the 5+ validation threshold
    if (meetsThreshold) {
      validatedEdges.push(edge);
      validatedEdgeKeys.add(acc.key);
    }
  }
  
  // Build weak edges: 5+ packets but below validation threshold, excluding validated edges
  for (const edge of edges) {
    if (!validatedEdgeKeys.has(edge.key) && edge.packetCount >= MIN_WEAK_EDGE_PACKETS) {
      weakEdges.push(edge);
    }
  }
  
  // Calculate strength scores: count (40%) × confidence (40%) × recency (20%)
  // Recency factor prevents stale edges from dominating the topology view
  for (const edge of edges) {
    const normalizedCount = maxPacketCount > 0 ? edge.packetCount / maxPacketCount : 0;
    // strength = count (40%) + confidence (40%) + recency (20%)
    // This weights recent activity so edges with only old data score lower
    edge.strength = normalizedCount * 0.4 + edge.avgConfidence * 0.4 + edge.avgRecency * 0.2;
  }
  
  // Sort by validation count (most validated = strongest topology signal)
  // Hub connections get priority boost to ensure they're never dropped
  edges.sort((a, b) => b.certainCount - a.certainCount);
  validatedEdges.sort((a, b) => {
    // Hub connections get +1000 boost to always appear first
    const aScore = a.certainCount + (a.isHubConnection ? 1000 : 0);
    const bScore = b.certainCount + (b.isHubConnection ? 1000 : 0);
    return bScore - aScore;
  });
  // Sort weak edges by packet count (weakest first for rendering order)
  weakEdges.sort((a, b) => a.packetCount - b.packetCount);
  
  // Cap rendered edges for performance
  // Priority: Hub connections first, then by validation count (strong > moderate > weak)
  const cappedEdges = validatedEdges.slice(0, MAX_RENDERED_EDGES);
  const cappedWeakEdges = weakEdges.slice(0, MAX_RENDERED_EDGES);
  
  // Build lookup map
  const edgeMap = new Map(edges.map(e => [e.key, e]));
  
  // === LOOP DETECTION (H₁ Homology) ===
  // Find cycles in the network - these represent redundant paths for resilience
  const { loops, loopEdgeKeys } = findNetworkLoops(validatedEdges, localHash, maxCertainCount);
  
  // Mark edges that are part of loops
  for (const edge of edges) {
    edge.isLoopEdge = loopEdgeKeys.has(edge.key);
  }
  
  // Log loop detection results in development
  if (process.env.NODE_ENV === 'development' && loops.length > 0) {
    console.log(`[mesh-topology] Found ${loops.length} loops:`, loops.map(l => ({
      id: l.id,
      size: l.size,
      nodes: l.nodes.length,
      strength: l.strength.toFixed(2),
      includesLocal: l.includesLocal,
    })));
  }
  
  // === PHASE 2: PATH SEQUENCE TRACKING ===
  // Build registry of observed paths for route analysis
  // NOTE: Must be built BEFORE TX delay recommendations (Phase 6 depends on it)
  const pathRegistry = buildPathRegistry(sortedPackets, localHash);
  
  // Log path registry stats in development
  if (process.env.NODE_ENV === 'development') {
    console.log(`[mesh-topology] Path registry: ${pathRegistry.uniquePathCount} unique paths, ${pathRegistry.totalObservations} observations`);
  }
  
  // === TX DELAY RECOMMENDATIONS FOR ALL NODES ===
  // Calculate recommended tx_delay and direct.tx_delay for all nodes with sufficient data
  // Phase 6: Now includes path position metrics from pathRegistry
  const txDelayRecommendations = calculateNodeTxDelays(
    edges,
    nodePathCounts,
    sortedPackets,
    pathRegistry,
    neighbors
  );
  
  // Log tx delay recommendations in development
  if (process.env.NODE_ENV === 'development' && txDelayRecommendations.size > 0) {
    const withData = [...txDelayRecommendations.values()].filter(r => !r.insufficientData).length;
    console.log(`[mesh-topology] TX delay recommendations: ${withData} nodes with data, ${txDelayRecommendations.size - withData} insufficient`);
  }
  
  // === PHASE 4: EDGE BETWEENNESS CENTRALITY ===
  // Calculate betweenness from observed paths (more accurate than count-based backbone)
  const edgeBetweenness = calculateEdgeBetweenness(pathRegistry, edges);
  const backboneEdges = identifyBackboneEdges(edgeBetweenness, 3, 0.3);
  
  // Log backbone edges in development
  if (process.env.NODE_ENV === 'development' && backboneEdges.length > 0) {
    console.log(`[mesh-topology] Backbone edges (by betweenness):`, backboneEdges.map(key => {
      const edge = edgeMap.get(key);
      return {
        key,
        betweenness: edgeBetweenness.get(key)?.toFixed(2),
        certainCount: edge?.certainCount,
      };
    }));
  }
  
  // === PHASE 5: MOBILE REPEATER DETECTION ===
  // Identify nodes that appear/disappear frequently from paths
  const { nodeMobility, mobileNodes } = calculateNodeMobility(pathRegistry, neighbors);
  
  // Log mobile nodes in development
  if (process.env.NODE_ENV === 'development' && mobileNodes.length > 0) {
    console.log(`[mesh-topology] Mobile nodes:`, mobileNodes.map(hash => {
      const mob = nodeMobility.get(hash);
      return {
        hash: hash.slice(0, 8),
        volatility: mob?.pathVolatility.toFixed(2),
        activeRatio: mob?.activeWindowRatio.toFixed(2),
      };
    }));
  }
  
  // === PHASE 7: PATH HEALTH INDICATORS ===
  // Calculate health metrics for top observed paths
  const pathHealth = calculatePathHealth(pathRegistry, edges, hubNodes, 20);
  
  // Log path health in development
  if (process.env.NODE_ENV === 'development' && pathHealth.length > 0) {
    console.log(`[mesh-topology] Path health:`, pathHealth.slice(0, 5).map(ph => ({
      path: ph.hops.join('>'),
      health: ph.healthScore,
      weakest: ph.weakestLinkConfidence.toFixed(2),
      observations: ph.observationCount,
    })));
  }
  
  // === BUILD LAST-HOP NEIGHBORS ARRAY ===
  // Convert collected prefix data into LastHopNeighbor objects
  // Each prefix that appeared as last hop becomes a neighbor entry
  // Disambiguation resolves which full hash each prefix maps to
  const lastHopNeighbors: LastHopNeighbor[] = [];
  
  for (const data of lastHopPrefixData.values()) {
    // Find the most likely hash for this prefix (highest count with reasonable confidence)
    let bestHash: string | null = null;
    let bestScore = 0;
    let bestConfidence = 0;
    
    for (const [hash, hashData] of data.resolvedHashes) {
      // Skip local node
      if (hash === localHash) continue;
      
      const avgConfidence = hashData.count > 0 ? hashData.confidenceSum / hashData.count : 0;
      // Score combines count and confidence
      const score = hashData.count * avgConfidence;
      
      if (score > bestScore) {
        bestScore = score;
        bestHash = hash;
        bestConfidence = avgConfidence;
      }
    }
    
    if (bestHash) {
      lastHopNeighbors.push({
        hash: bestHash,
        prefix: data.prefix,
        count: data.count,
        confidence: bestConfidence,
        avgRssi: data.rssiCount > 0 ? data.rssiSum / data.rssiCount : null,
        avgSnr: data.snrCount > 0 ? data.snrSum / data.snrCount : null,
        lastSeen: data.lastSeen,
      });
    }
  }
  
  // Sort by count descending (most traffic first)
  lastHopNeighbors.sort((a, b) => b.count - a.count);
  
  // Log last-hop neighbors in development
  if (process.env.NODE_ENV === 'development' && lastHopNeighbors.length > 0) {
    console.log(`[mesh-topology] Last-hop neighbors (${lastHopNeighbors.length}):`, lastHopNeighbors.map(n => ({
      prefix: n.prefix,
      hash: n.hash.slice(0, 8),
      count: n.count,
      conf: n.confidence.toFixed(2),
      rssi: n.avgRssi?.toFixed(0),
      snr: n.avgSnr?.toFixed(1),
    })));
  }
  
  return {
    edges, 
    validatedEdges: cappedEdges,
    weakEdges: cappedWeakEdges,
    certainEdges: cappedEdges, // Legacy alias
    uncertainEdges: [], // No longer rendered
    edgeMap, 
    maxPacketCount, 
    maxCertainCount,
    neighborAffinity: simpleAffinity, 
    fullAffinity: neighborAffinity, 
    localPrefix,
    centrality,
    hubNodes,
    loops,
    loopEdgeKeys,
    txDelayRecommendations,
    // Phase 2: Path registry
    pathRegistry,
    // Phase 4: Edge betweenness
    edgeBetweenness,
    backboneEdges,
    // Phase 5: Mobile repeater detection
    nodeMobility,
    mobileNodes,
    // Phase 7: Path health indicators
    pathHealth,
    // Last-hop neighbors (ground truth from packet paths)
    lastHopNeighbors,
  };
}

// Edge styling utilities are now in edge-styling.ts
// Re-exported above for backward compatibility
