/**
 * Mesh Topology Analysis
 * 
 * Analyzes packet paths to build a network graph with confidence-weighted edges.
 * Uses the centralized prefix disambiguation system for consistent prefix resolution.
 * 
 * Key features:
 * - Prefix disambiguation: resolves 2-char prefix collisions using position, co-occurrence, and geography
 * - Edge certainty: uses disambiguation confidence to determine edge validity
 * - Betweenness centrality: identifies hub nodes (high-traffic forwarders)
 */

import { Packet, NeighborInfo } from '@/types/api';
import { 
  buildPrefixLookup, 
  resolvePrefix, 
  getHashPrefix,
  getDisambiguationStats,
} from './prefix-disambiguation';

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
  /** Strength score (0-1) combining count and confidence */
  strength: number;
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
}

/** Minimum validations required for an edge to be rendered */
export const MIN_EDGE_VALIDATIONS = 5;

/** Confidence threshold for counting an edge as "certain" */
export const CERTAINTY_CONFIDENCE_THRESHOLD = 0.6;

/** Maximum edges to render (performance cap) */
export const MAX_RENDERED_EDGES = 100;

/** Result of topology analysis */
export interface MeshTopology {
  /** All edges with 3+ validations */
  edges: TopologyEdge[];
  /** Edges meeting validation threshold (for rendering) */
  validatedEdges: TopologyEdge[];
  /** Legacy: certain edges (alias for validatedEdges) */
  certainEdges: TopologyEdge[];
  /** Legacy: uncertain edges (empty - we no longer render these) */
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
}

// Re-export getHashPrefix from prefix-disambiguation for backward compatibility
export { getHashPrefix };

/**
 * Check if a path prefix matches a hash.
 * Path prefixes are 2-char hex (e.g., "19").
 * Hashes can be "0xNN" format or full hex strings.
 */
export function prefixMatches(prefix: string, hash: string): boolean {
  const normalizedPrefix = prefix.toUpperCase();
  // Handle "0x" prefix
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    const hashHex = hash.slice(2).toUpperCase();
    return hashHex.startsWith(normalizedPrefix);
  }
  // For full hex strings, check if first N chars match
  return hash.toUpperCase().startsWith(normalizedPrefix);
}

/**
 * Calculate distance between two coordinates in meters using Haversine formula.
 */
function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate proximity score (0-1) based on distance.
 * Closer neighbors get higher scores.
 * - < 100m: 1.0 (very close, likely direct neighbor)
 * - < 500m: 0.8
 * - < 1km: 0.6
 * - < 5km: 0.4
 * - < 10km: 0.2
 * - > 10km: 0.1
 */
function getProximityScore(distanceMeters: number): number {
  if (distanceMeters < 100) return 1.0;
  if (distanceMeters < 500) return 0.8;
  if (distanceMeters < 1000) return 0.6;
  if (distanceMeters < 5000) return 0.4;
  if (distanceMeters < 10000) return 0.2;
  return 0.1;
}

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
  // localHash is passed but not used directly in affinity building
  // (it's used later in buildMeshTopology for edge creation)
  void localHash;
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
  // NOTE: MeshCore paths are [first_hop, ..., last_hop] where last_hop is the node
  // that transmitted the packet to us. Local is NOT appended to the path.
  // So hop distance is relative to the END of the path (which is our direct neighbor).
  for (const packet of packets) {
    // Note: paths may be JSON strings or arrays depending on API version
    let path = packet.forwarded_path ?? packet.original_path;
    
    // Parse JSON string if needed
    if (typeof path === 'string') {
      try {
        path = JSON.parse(path);
      } catch {
        continue; // Invalid JSON, skip
      }
    }
    
    if (path && Array.isArray(path) && path.length >= 1) {
      // Process ALL paths - the last element is always the node that forwarded to us
      // Hop positions: last element = 1-hop (direct forwarder), second-to-last = 2-hop, etc.
      for (let i = 0; i < path.length; i++) {
        const prefix = path[i];
        // hopDistance from local: last element = 1 (direct), second-to-last = 2, etc.
        const hopDistance = path.length - i;
        
        // Find matching neighbors and update their hop stats
        for (const [hash, aff] of affinity) {
          if (prefixMatches(prefix, hash)) {
            aff.frequency++;
            
            // Track hop position (index 0 = 1-hop, index 1 = 2-hop, etc.)
            const hopIndex = Math.min(hopDistance - 1, 4); // Cap at 5 positions
            aff.hopPositionCounts[hopIndex]++;
            
            // Track direct forwards specifically (last element in path)
            if (i === path.length - 1) {
              aff.directForwardCount++;
            }
          }
        }
      }
    }
    
    // Also count direct packets (empty path) from src_hash
    if ((!path || (Array.isArray(path) && path.length === 0)) && packet.src_hash) {
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


/**
 * Match a 2-character prefix to known node hashes.
 * Returns matching hashes and the probability based on combined affinity scores.
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
  
  // Helper to add/update edge accumulator
  const addEdgeObservation = (
    fromHash: string,
    toHash: string,
    hopConfidence: number,
    isCertain: boolean,
    hopDistanceFromLocal: number
  ) => {
    const key = makeEdgeKey(fromHash, toHash);
    const existing = accumulators.get(key);
    
    if (existing) {
      existing.count++;
      existing.confidenceSum += hopConfidence;
      existing.minHopDistance = Math.min(existing.minHopDistance, hopDistanceFromLocal);
      if (hopDistanceFromLocal < existing.hopDistanceCounts.length) {
        existing.hopDistanceCounts[hopDistanceFromLocal]++;
      }
      if (isCertain) {
        existing.certainCount++;
      } else {
        existing.uncertainCount++;
      }
    } else {
      const hopCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      if (hopDistanceFromLocal < hopCounts.length) {
        hopCounts[hopDistanceFromLocal]++;
      }
      accumulators.set(key, {
        fromHash,
        toHash,
        key,
        count: 1,
        confidenceSum: hopConfidence,
        minHopDistance: hopDistanceFromLocal,
        hopDistanceCounts: hopCounts,
        certainCount: isCertain ? 1 : 0,
        uncertainCount: isCertain ? 0 : 1,
      });
    }
  };
  
  for (const packet of sortedPackets) {
    // Get path from packet (forwarded_path has local appended)
    // Note: paths may be JSON strings or arrays depending on API version
    let path = packet.forwarded_path ?? packet.original_path;
    
    // Parse JSON string if needed
    if (typeof path === 'string') {
      try {
        path = JSON.parse(path);
      } catch {
        continue; // Invalid JSON, skip
      }
    }
    
    if (!path || !Array.isArray(path) || path.length < 1) continue;
    
    // Track which nodes appear in this path (for centrality)
    const nodesInPath = new Set<string>();
    
    // === SOURCE → FIRST HOP INFERENCE (ALL PACKET TYPES) ===
    // For any packet with src_hash, we can infer an edge from the source to the first hop
    // This reveals the source's direct RF neighbor on their side of the network
    if (packet.src_hash && path.length >= 1) {
      const firstHopPrefix = path[0];
      
      // Resolve the first hop using disambiguation system
      const firstHopResult = resolvePrefix(prefixLookup, firstHopPrefix, {
        position: 1, // 1-indexed position (first element)
        adjacentPrefixes: path.length > 1 ? [path[1]] : [],
      });
      
      // The source hash is known exactly (from the packet)
      const srcHash = packet.src_hash;
      
      if (firstHopResult.hash && firstHopResult.hash !== srcHash) {
        // Use disambiguation confidence for certainty
        const srcInNeighbors = Object.keys(neighbors).includes(srcHash);
        const isCertain = firstHopResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD && srcInNeighbors;
        const confidence = firstHopResult.confidence * (srcInNeighbors ? 1 : 0.8);
        
        // This edge is at the FAR end of the path from local's perspective
        // Hop distance = path length (since source is before the first element)
        const hopDistance = path.length;
        
        addEdgeObservation(srcHash, firstHopResult.hash, confidence, isCertain, hopDistance);
        
        // Track for centrality
        nodesInPath.add(srcHash);
        nodesInPath.add(firstHopResult.hash);
      }
    }
    
    // === LAST HOP → LOCAL INFERENCE (ALL PACKET TYPES) ===
    // The last element in the path is always our direct neighbor who forwarded to us
    // This is a 100% CERTAIN edge - we received the packet directly from them!
    if (localHash && path.length >= 1) {
      const lastHopPrefix = path[path.length - 1];
      
      // Resolve the last hop using disambiguation system
      const lastHopResult = resolvePrefix(prefixLookup, lastHopPrefix, {
        position: path.length, // 1-indexed position (last element)
        adjacentPrefixes: path.length > 1 ? [path[path.length - 2]] : [],
        isLastHop: true,
      });
      
      if (lastHopResult.hash && lastHopResult.hash !== localHash) {
        // This edge touches local directly - hop distance = 0
        //
        // Use the disambiguation confidence which includes the dominant forwarder boost.
        // An edge is "certain" if the disambiguation confidence meets our threshold.
        // This allows edges with prefix collisions to still be validated when the
        // disambiguation system is highly confident (e.g., dominant forwarder).
        const isCertain = lastHopResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD;
        const confidence = lastHopResult.confidence;
        
        addEdgeObservation(lastHopResult.hash, localHash, confidence, isCertain, 0);
        
        // Track for centrality
        nodesInPath.add(lastHopResult.hash);
        nodesInPath.add(localHash);
      }
    }
    
    // Process consecutive pairs in the path - these are actual RF links
    for (let i = 0; i < path.length - 1; i++) {
      const fromPrefix = path[i];
      const toPrefix = path[i + 1];
      const isToLastHop = (i + 1) === path.length - 1;
      
      // Resolve both ends using disambiguation system with context
      const fromResult = resolvePrefix(prefixLookup, fromPrefix, {
        position: i + 1, // 1-indexed
        adjacentPrefixes: [
          ...(i > 0 ? [path[i - 1]] : []),
          path[i + 1],
        ],
      });
      
      const toResult = resolvePrefix(prefixLookup, toPrefix, {
        position: i + 2, // 1-indexed
        adjacentPrefixes: [
          path[i],
          ...(i + 2 < path.length ? [path[i + 2]] : []),
        ],
        isLastHop: isToLastHop,
      });
      
      // Skip if either end couldn't be resolved
      if (!fromResult.hash || !toResult.hash) continue;
      
      // Skip self-loops
      if (fromResult.hash === toResult.hash) continue;
      
      // Determine if this observation is "certain" based on disambiguation confidence
      // An observation is certain if BOTH endpoints have confidence >= threshold
      const isCertainObservation = 
        fromResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD && 
        toResult.confidence >= CERTAINTY_CONFIDENCE_THRESHOLD;
      
      // Track nodes for centrality
      nodesInPath.add(fromResult.hash);
      nodesInPath.add(toResult.hash);
      
      // Track bridge nodes (middle of path = not first or last)
      if (i > 0) {
        nodeBridgeCounts.set(fromResult.hash, (nodeBridgeCounts.get(fromResult.hash) || 0) + 1);
      }
      
      // Calculate combined confidence for this hop
      const hopConfidence = fromResult.confidence * toResult.confidence;
      
      // For uncertain edges, apply threshold; certain edges always included
      if (!isCertainObservation && hopConfidence < confidenceThreshold) continue;
      
      // Calculate hop distance from local (0 = edge touches local)
      // For path [A, B, C, local]: A-B is 2 hops from local, B-C is 1 hop, C-local is 0 hops
      const hopDistanceFromLocal = localPrefix 
        ? Math.max(0, path.length - 2 - i) 
        : 99;
      
      // Add edge observation using helper
      addEdgeObservation(
        fromResult.hash,
        toResult.hash,
        hopConfidence,
        isCertainObservation,
        hopDistanceFromLocal
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
  
  // Identify hub nodes using the 3+ validation baseline
  // Hub = appears in at least 3 validated paths AND has high centrality
  const minPathsForHub = Math.max(MIN_EDGE_VALIDATIONS, Math.floor(packets.length * 0.01)); // At least 3 or 1% of packets
  const hubNodes: string[] = [];
  const sortedByCentrality = [...centrality.entries()]
    .filter(([hash, _]) => (nodePathCounts.get(hash) || 0) >= minPathsForHub)
    .sort((a, b) => b[1] - a[1]);
  
  // Take nodes with centrality >= 0.5 (normalized) as hubs
  for (const [hash, score] of sortedByCentrality) {
    if (score >= 0.5) {
      hubNodes.push(hash);
    }
  }
  
  // Convert accumulators to edges
  // Only include edges with MIN_EDGE_VALIDATIONS (3+) certain observations
  const edges: TopologyEdge[] = [];
  const validatedEdges: TopologyEdge[] = [];
  let maxPacketCount = 0;
  let maxCertainCount = 0;
  const hubSet = new Set(hubNodes);
  
  for (const acc of accumulators.values()) {
    const avgConfidence = acc.confidenceSum / acc.count;
    maxPacketCount = Math.max(maxPacketCount, acc.count);
    maxCertainCount = Math.max(maxCertainCount, acc.certainCount);
    
    // Check if either end is a hub node
    const isHubConnection = hubSet.has(acc.fromHash) || hubSet.has(acc.toHash);
    
    // An edge meets the validation threshold if it has 3+ certain observations
    const meetsThreshold = acc.certainCount >= MIN_EDGE_VALIDATIONS;
    
    const edge: TopologyEdge = {
      fromHash: acc.fromHash,
      toHash: acc.toHash,
      key: acc.key,
      packetCount: acc.count,
      avgConfidence,
      strength: 0, // Will be calculated below
      hopDistanceFromLocal: acc.minHopDistance,
      isHubConnection,
      isCertain: meetsThreshold, // Now means "meets validation threshold"
      certainCount: acc.certainCount,
    };
    
    edges.push(edge);
    
    // Only include edges that meet the 3+ validation threshold
    if (meetsThreshold) {
      validatedEdges.push(edge);
    }
  }
  
  // Calculate strength scores (normalized count × confidence)
  for (const edge of edges) {
    const normalizedCount = maxPacketCount > 0 ? edge.packetCount / maxPacketCount : 0;
    edge.strength = normalizedCount * edge.avgConfidence;
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
  
  // Cap rendered edges for performance
  // Priority: Hub connections first, then by validation count (strong > moderate > weak)
  const cappedEdges = validatedEdges.slice(0, MAX_RENDERED_EDGES);
  
  // Build lookup map
  const edgeMap = new Map(edges.map(e => [e.key, e]));
  
  return { 
    edges, 
    validatedEdges: cappedEdges,
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
  };
}

/**
 * Get line weight for an edge based on its strength.
 * Returns a weight between minWeight and maxWeight.
 */
export function getEdgeWeight(
  strength: number,
  minWeight: number = 1.5,
  maxWeight: number = 5
): number {
  return minWeight + (maxWeight - minWeight) * strength;
}

/**
 * Get line color for an edge based on its strength.
 * @deprecated Use getEdgeColorByHopDistance for better topology visualization
 */
export function getEdgeColor(strength: number): string {
  if (strength >= 0.7) {
    return 'rgba(74, 222, 128, 0.8)'; // green-400
  } else if (strength >= 0.4) {
    return 'rgba(34, 211, 238, 0.6)'; // cyan-400
  } else {
    return 'rgba(255, 255, 255, 0.35)';
  }
}

/**
 * Get line color for an edge based on hop distance from local node.
 * Closer edges are more vibrant, further edges fade out.
 * 
 * @param hopDistance - Hops from local (0 = touches local, 1 = one hop away, etc.)
 * @param isHubConnection - Whether this edge connects to a high-centrality hub node
 */
export function getEdgeColorByHopDistance(hopDistance: number, isHubConnection: boolean = false): string {
  // Hub connections get a distinct color (gold/amber)
  if (isHubConnection && hopDistance <= 1) {
    return 'rgba(251, 191, 36, 0.85)'; // amber-400 - hub connections
  }
  
  switch (hopDistance) {
    case 0:
      // Direct connection to local - bright cyan
      return 'rgba(34, 211, 238, 0.9)'; // cyan-400
    case 1:
      // One hop away - green
      return 'rgba(74, 222, 128, 0.8)'; // green-400
    case 2:
      // Two hops - yellow/lime
      return 'rgba(163, 230, 53, 0.7)'; // lime-400
    case 3:
      // Three hops - orange
      return 'rgba(251, 146, 60, 0.6)'; // orange-400
    default:
      // 4+ hops - faded white
      return 'rgba(255, 255, 255, 0.3)';
  }
}

/**
 * Get line weight for an edge based on hop distance and packet count.
 * Closer, high-traffic edges are thicker.
 * 
 * @param hopDistance - Hops from local
 * @param normalizedCount - Packet count normalized to 0-1
 * @param minWeight - Minimum line weight
 * @param maxWeight - Maximum line weight
 */
export function getEdgeWeightByHopDistance(
  hopDistance: number,
  normalizedCount: number,
  minWeight: number = 1,
  maxWeight: number = 5
): number {
  // Base weight from packet count
  const countWeight = minWeight + (maxWeight - minWeight) * normalizedCount;
  
  // Reduce weight for distant edges
  const distanceFactor = Math.max(0.4, 1 - hopDistance * 0.15);
  
  return countWeight * distanceFactor;
}

/**
 * Get line weight for a CERTAIN edge based on how many times the path was validated.
 * More frequent = thicker line.
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 * @param minWeight - Minimum line weight
 * @param maxWeight - Maximum line weight
 */
export function getCertainEdgeWeight(
  certainCount: number,
  maxCertainCount: number,
  minWeight: number = 1.5,
  maxWeight: number = 6
): number {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  return minWeight + (maxWeight - minWeight) * normalized;
}

/**
 * Get color for an UNCERTAIN edge based on confidence level.
 * Uses a gradient from red (low confidence) to yellow (medium) to white (high).
 * 
 * @param confidence - Confidence score 0-1
 */
export function getUncertainEdgeColor(confidence: number): string {
  if (confidence >= 0.9) {
    // Very high confidence - light purple (almost certain)
    return 'rgba(196, 181, 253, 0.6)'; // violet-300
  } else if (confidence >= 0.7) {
    // High confidence - blue
    return 'rgba(147, 197, 253, 0.5)'; // blue-300
  } else if (confidence >= 0.5) {
    // Medium confidence - yellow
    return 'rgba(253, 224, 71, 0.4)'; // yellow-300
  } else {
    // Low confidence - orange/red
    return 'rgba(253, 186, 116, 0.3)'; // orange-300
  }
}

/** Relative validation thresholds for link quality tiers (% of max) */
export const LINK_QUALITY_THRESHOLDS = {
  STRONG: 0.24,  // 24%+ of max = strong (green)
  MEDIUM: 0.12,  // 12%+ of max = medium (yellow)
  WEAK: 0.06,    // 6%+ of max = weak (red)
};

/**
 * Get color for a CERTAIN edge based on link quality (relative to max validation count).
 * Green = strong (24%+), Yellow = medium (12-23%), Red = weak (6-11%).
 * All colors are fully opaque.
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 */
export function getLinkQualityColor(certainCount: number, maxCertainCount: number): string {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  
  if (normalized >= LINK_QUALITY_THRESHOLDS.STRONG) {
    // Strong link - bright green (24%+)
    return 'rgb(74, 222, 128)'; // green-400
  } else if (normalized >= LINK_QUALITY_THRESHOLDS.MEDIUM) {
    // Medium link - yellow (12-23%)
    return 'rgb(250, 204, 21)'; // yellow-400
  } else {
    // Weak link - red (<12%)
    return 'rgb(248, 113, 113)'; // red-400
  }
}

/**
 * Get line weight for a CERTAIN edge based on link quality (relative to max validation count).
 * Strong = thickest, medium = medium, weak = thinnest.
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 */
export function getLinkQualityWeight(
  certainCount: number,
  maxCertainCount: number
): number {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  
  if (normalized >= LINK_QUALITY_THRESHOLDS.STRONG) {
    // Strong link - thickest (6px, +1px from before)
    return 6;
  } else if (normalized >= LINK_QUALITY_THRESHOLDS.MEDIUM) {
    // Medium link
    return 3;
  } else {
    // Weak link - thinnest
    return 1.5;
  }
}
