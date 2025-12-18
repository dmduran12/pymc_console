/**
 * Mesh Topology Analysis
 * 
 * Analyzes packet paths to build a network graph with confidence-weighted edges.
 * Uses probabilistic prefix matching (2-char hex prefixes have 256 possible values).
 * Only creates edges when confidence meets the threshold (default 80%).
 * 
 * Enhanced features:
 * - Local node prefix detection: last path element matching local prefix = receiving node
 * - Neighbor affinity: tracks strongest neighbors to break ties in 50/50 decisions
 * - src_hash and dst_hash correlation for additional confidence
 */

import { Packet, NeighborInfo } from '@/types/api';

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

/** Result of topology analysis */
export interface MeshTopology {
  /** All edges (both certain and uncertain) */
  edges: TopologyEdge[];
  /** 100% certain edges only (both endpoints uniquely identified) - solid lines */
  certainEdges: TopologyEdge[];
  /** Uncertain/inferred edges (at least one ambiguous endpoint) - dotted lines */
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

/**
 * Extract the 2-character prefix from a hash.
 * Handles both "0xNN" format (local hash) and full hex strings (neighbor hashes).
 */
export function getHashPrefix(hash: string): string {
  // Handle "0x" prefix - extract the hex part after it
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2).toUpperCase();
  }
  // For full hex strings, take first 2 characters
  return hash.slice(0, 2).toUpperCase();
}

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
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
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
    
    if (path && Array.isArray(path) && path.length >= 1 && localPrefix) {
      const lastPrefix = path[path.length - 1];
      const pathEndsWithLocal = lastPrefix.toUpperCase() === localPrefix;
      
      if (pathEndsWithLocal) {
        // Analyze each position in the path (excluding local at end)
        for (let i = 0; i < path.length - 1; i++) {
          const prefix = path[i];
          // hopDistance: 1 = second-to-last (direct forwarder), 2 = third-to-last, etc.
          const hopDistance = path.length - 1 - i;
          
          // Find matching neighbors and update their hop stats
          for (const [hash, aff] of affinity) {
            if (prefixMatches(prefix, hash)) {
              aff.frequency++;
              
              // Track hop position (index 0 = 1-hop, index 1 = 2-hop, etc.)
              const hopIndex = Math.min(hopDistance - 1, 4); // Cap at 5 positions
              aff.hopPositionCounts[hopIndex]++;
              
              // Track direct forwards specifically
              if (hopDistance === 1) {
                aff.directForwardCount++;
              }
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
  
  // If this is the last hop and local matches, strongly prefer local
  // (packets we receive end with our prefix)
  if (isLastHop && localMatches && localHash) {
    return {
      matches,
      probability: 1, // High confidence - last hop is us
      bestMatch: localHash,
    };
  }
  
  // Calculate base probability
  const baseProbability = matches.length > 0 ? 1 / matches.length : 0;
  
  // Determine best match using affinity for tiebreaking
  let bestMatch: string | null = null;
  let bestScore = -1;
  
  if (matches.length === 1) {
    bestMatch = matches[0];
  } else if (matches.length > 1 && neighborAffinity) {
    // Use combined affinity scores to pick the most likely candidate
    for (const hash of matches) {
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
    // If no affinity data, fall back to first match
    if (!bestMatch) bestMatch = matches[0];
  } else if (matches.length > 0) {
    bestMatch = matches[0];
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
 * Calculate confidence for a single hop in a path.
 * Returns the resolved hash and the confidence score.
 * 
 * @param prefix - The 2-char prefix to resolve
 * @param neighbors - Known neighbors
 * @param localHash - Local node's full hash  
 * @param neighborAffinity - Affinity map (supports both simple and combined formats)
 * @param isLastHop - Whether this is the last element in the path
 */
function resolveHop(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  neighborAffinity?: Map<string, number | NeighborAffinity>,
  isLastHop: boolean = false
): { hash: string | null; confidence: number } {
  const { matches, probability, bestMatch } = matchPrefix(
    prefix, 
    neighbors, 
    localHash, 
    neighborAffinity,
    isLastHop
  );
  
  if (matches.length === 1) {
    // Exact match - 100% confidence
    return { hash: matches[0], confidence: 1 };
  } else if (matches.length > 1) {
    // matchPrefix already calculates probability based on affinity
    return { hash: bestMatch, confidence: probability };
  }
  
  // No match
  return { hash: null, confidence: 0 };
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
  // First pass: build neighbor affinity map with proximity scores
  const neighborAffinity = buildNeighborAffinity(packets, neighbors, localLat, localLon, localHash);
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
  
  for (const packet of packets) {
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
      
      // Resolve the first hop (this is the node that received the packet directly from source)
      const firstHopMatches = matchPrefix(firstHopPrefix, neighbors, localHash, neighborAffinity, false);
      const firstHopResolved = resolveHop(firstHopPrefix, neighbors, localHash, neighborAffinity, false);
      
      // The source hash is known exactly (from the packet)
      const srcHash = packet.src_hash;
      
      if (firstHopResolved.hash && firstHopResolved.hash !== srcHash) {
        // This is a certain edge if we uniquely identify the first hop
        // AND the source is a known neighbor (or at least has high affinity)
        const srcInNeighbors = Object.keys(neighbors).includes(srcHash);
        const isCertain = firstHopMatches.matches.length === 1 && srcInNeighbors;
        const confidence = isCertain ? 1 : (srcInNeighbors ? 0.9 : 0.7);
        
        // This edge is at the FAR end of the path from local's perspective
        // Hop distance = path length (since source is before the first element)
        const hopDistance = path.length;
        
        addEdgeObservation(srcHash, firstHopResolved.hash, confidence, isCertain, hopDistance);
        
        // Track for centrality
        nodesInPath.add(srcHash);
        nodesInPath.add(firstHopResolved.hash);
      }
    }
    
    // === LAST HOP → LOCAL INFERENCE (ALL PACKET TYPES) ===
    // The last element in the path is always our direct neighbor who forwarded to us
    // This is a 100% CERTAIN edge - we received the packet directly from them!
    if (localHash && path.length >= 1) {
      const lastHopPrefix = path[path.length - 1];
      
      // Resolve the last hop
      const lastHopMatches = matchPrefix(lastHopPrefix, neighbors, localHash, neighborAffinity, true);
      const lastHopResolved = resolveHop(lastHopPrefix, neighbors, localHash, neighborAffinity, true);
      
      if (lastHopResolved.hash && lastHopResolved.hash !== localHash) {
        // This edge touches local directly - hop distance = 0
        // Certainty depends on whether last hop uniquely resolves
        const isCertain = lastHopMatches.matches.length === 1;
        const confidence = isCertain ? 1 : lastHopResolved.confidence;
        
        addEdgeObservation(lastHopResolved.hash, localHash, confidence, isCertain, 0);
        
        // Track for centrality
        nodesInPath.add(lastHopResolved.hash);
        nodesInPath.add(localHash);
      }
    }
    
    // Process consecutive pairs in the path - these are actual RF links
    for (let i = 0; i < path.length - 1; i++) {
      const fromPrefix = path[i];
      const toPrefix = path[i + 1];
      const isToLastHop = (i + 1) === path.length - 1;
      
      // Get all matches for both endpoints (to determine certainty)
      const fromMatches = matchPrefix(fromPrefix, neighbors, localHash, neighborAffinity, false);
      const toMatches = matchPrefix(toPrefix, neighbors, localHash, neighborAffinity, isToLastHop);
      
      // Resolve both ends of this hop with affinity tiebreaking
      const fromResolved = resolveHop(fromPrefix, neighbors, localHash, neighborAffinity, false);
      const toResolved = resolveHop(toPrefix, neighbors, localHash, neighborAffinity, isToLastHop);
      
      // Skip if either end couldn't be resolved
      if (!fromResolved.hash || !toResolved.hash) continue;
      
      // Skip self-loops
      if (fromResolved.hash === toResolved.hash) continue;
      
      // Determine if this observation is 100% certain
      // Certain = both endpoints have exactly 1 match (unique identification)
      const isCertainObservation = fromMatches.matches.length === 1 && toMatches.matches.length === 1;
      
      // Track nodes for centrality
      nodesInPath.add(fromResolved.hash);
      nodesInPath.add(toResolved.hash);
      
      // Track bridge nodes (middle of path = not first or last)
      if (i > 0) {
        nodeBridgeCounts.set(fromResolved.hash, (nodeBridgeCounts.get(fromResolved.hash) || 0) + 1);
      }
      
      // Calculate combined confidence for this hop
      const hopConfidence = fromResolved.confidence * toResolved.confidence;
      
      // For uncertain edges, apply threshold; certain edges always included
      if (!isCertainObservation && hopConfidence < confidenceThreshold) continue;
      
      // Calculate hop distance from local (0 = edge touches local)
      // For path [A, B, C, local]: A-B is 2 hops from local, B-C is 1 hop, C-local is 0 hops
      const hopDistanceFromLocal = localPrefix 
        ? Math.max(0, path.length - 2 - i) 
        : 99;
      
      // Add edge observation using helper
      addEdgeObservation(
        fromResolved.hash,
        toResolved.hash,
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
  
  // Identify hub nodes (top 20% centrality and minimum path count)
  const minPathsForHub = Math.max(3, packets.length * 0.05); // At least 5% of packets or 3
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
  const edges: TopologyEdge[] = [];
  const certainEdges: TopologyEdge[] = [];
  const uncertainEdges: TopologyEdge[] = [];
  let maxPacketCount = 0;
  let maxCertainCount = 0;
  const hubSet = new Set(hubNodes);
  
  for (const acc of accumulators.values()) {
    const avgConfidence = acc.confidenceSum / acc.count;
    maxPacketCount = Math.max(maxPacketCount, acc.count);
    maxCertainCount = Math.max(maxCertainCount, acc.certainCount);
    
    // Check if either end is a hub node
    const isHubConnection = hubSet.has(acc.fromHash) || hubSet.has(acc.toHash);
    
    // An edge is "certain" if it has at least one 100% certain observation
    const isCertain = acc.certainCount > 0;
    
    const edge: TopologyEdge = {
      fromHash: acc.fromHash,
      toHash: acc.toHash,
      key: acc.key,
      packetCount: acc.count,
      avgConfidence,
      strength: 0, // Will be calculated below
      hopDistanceFromLocal: acc.minHopDistance,
      isHubConnection,
      isCertain,
      certainCount: acc.certainCount,
    };
    
    edges.push(edge);
    
    // Separate into certain vs uncertain lists
    if (isCertain) {
      certainEdges.push(edge);
    } else {
      uncertainEdges.push(edge);
    }
  }
  
  // Calculate strength scores (normalized count × confidence)
  for (const edge of edges) {
    const normalizedCount = maxPacketCount > 0 ? edge.packetCount / maxPacketCount : 0;
    edge.strength = normalizedCount * edge.avgConfidence;
  }
  
  // Sort all lists by strength descending
  edges.sort((a, b) => b.strength - a.strength);
  certainEdges.sort((a, b) => b.certainCount - a.certainCount); // Sort certain by frequency
  uncertainEdges.sort((a, b) => b.avgConfidence - a.avgConfidence); // Sort uncertain by confidence
  
  // Build lookup map
  const edgeMap = new Map(edges.map(e => [e.key, e]));
  
  return { 
    edges, 
    certainEdges,
    uncertainEdges,
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

/**
 * Get color for a CERTAIN edge based on link quality (validation frequency).
 * Green = strong/frequent, Yellow = moderate, Orange/Red = weak/infrequent.
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 */
export function getLinkQualityColor(certainCount: number, maxCertainCount: number): string {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  
  if (normalized >= 0.7) {
    // Strong link - bright green
    return 'rgba(74, 222, 128, 0.9)'; // green-400
  } else if (normalized >= 0.4) {
    // Moderate link - lime/yellow-green
    return 'rgba(163, 230, 53, 0.8)'; // lime-400
  } else if (normalized >= 0.2) {
    // Weaker link - yellow
    return 'rgba(250, 204, 21, 0.7)'; // yellow-400
  } else if (normalized >= 0.1) {
    // Weak link - orange
    return 'rgba(251, 146, 60, 0.6)'; // orange-400
  } else {
    // Very weak link - red/coral
    return 'rgba(248, 113, 113, 0.5)'; // red-400
  }
}

/**
 * Get line weight for a CERTAIN edge based on link quality (validation frequency).
 * More frequent = thicker (stronger link).
 * 
 * @param certainCount - Number of certain observations
 * @param maxCertainCount - Maximum certain count for normalization
 * @param minWeight - Minimum line weight
 * @param maxWeight - Maximum line weight
 */
export function getLinkQualityWeight(
  certainCount: number,
  maxCertainCount: number,
  minWeight: number = 1,
  maxWeight: number = 5
): number {
  const normalized = maxCertainCount > 0 ? certainCount / maxCertainCount : 0;
  // Use sqrt for a more gradual scale (so thin lines aren't too thin)
  return minWeight + (maxWeight - minWeight) * Math.sqrt(normalized);
}
