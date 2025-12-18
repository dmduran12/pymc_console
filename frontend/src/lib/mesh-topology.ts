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
}

/** Result of topology analysis */
export interface MeshTopology {
  edges: TopologyEdge[];
  /** Map from edge key to edge for quick lookup */
  edgeMap: Map<string, TopologyEdge>;
  /** Max packet count across all edges (for normalization) */
  maxPacketCount: number;
  /** Neighbor affinity scores (hash -> combined score for backward compat) */
  neighborAffinity: Map<string, number>;
  /** Full affinity data with hop statistics (hash -> NeighborAffinity) */
  fullAffinity: Map<string, NeighborAffinity>;
  /** Local node's 2-char prefix (derived from localHash) */
  localPrefix: string | null;
}

interface EdgeAccumulator {
  fromHash: string;
  toHash: string;
  key: string;
  count: number;
  confidenceSum: number;
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
  const hashPrefix = getHashPrefix(hash);
  return hashPrefix === prefix.toUpperCase();
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
    const path = packet.forwarded_path ?? packet.original_path;
    
    if (path && path.length >= 1 && localPrefix) {
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
    if ((!path || path.length === 0) && packet.src_hash) {
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
 * @param packets - All packets to analyze
 * @param neighbors - Known neighbors with location data
 * @param localHash - Local node's hash
 * @param confidenceThreshold - Minimum per-hop confidence to include (default 0.8)
 * @param localLat - Local node latitude (for proximity calculations)
 * @param localLon - Local node longitude (for proximity calculations)
 * @returns MeshTopology with edges that meet the confidence threshold
 */
export function buildMeshTopology(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  confidenceThreshold: number = 0.8,
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
  
  // Accumulate edge observations
  const accumulators = new Map<string, EdgeAccumulator>();
  
  for (const packet of packets) {
    // Get path from packet
    const path = packet.forwarded_path ?? packet.original_path;
    if (!path || !Array.isArray(path) || path.length < 2) continue;
    
    // Process consecutive pairs in the path
    for (let i = 0; i < path.length - 1; i++) {
      const fromPrefix = path[i];
      const toPrefix = path[i + 1];
      const isToLastHop = (i + 1) === path.length - 1;
      
      // Resolve both ends of this hop with affinity tiebreaking
      const fromResolved = resolveHop(fromPrefix, neighbors, localHash, neighborAffinity, false);
      const toResolved = resolveHop(toPrefix, neighbors, localHash, neighborAffinity, isToLastHop);
      
      // Skip if either end couldn't be resolved
      if (!fromResolved.hash || !toResolved.hash) continue;
      
      // Skip self-loops
      if (fromResolved.hash === toResolved.hash) continue;
      
      // Calculate combined confidence for this hop
      const hopConfidence = fromResolved.confidence * toResolved.confidence;
      
      // Skip if below threshold
      if (hopConfidence < confidenceThreshold) continue;
      
      // Create/update edge accumulator
      const key = makeEdgeKey(fromResolved.hash, toResolved.hash);
      const existing = accumulators.get(key);
      
      if (existing) {
        existing.count++;
        existing.confidenceSum += hopConfidence;
      } else {
        accumulators.set(key, {
          fromHash: fromResolved.hash,
          toHash: toResolved.hash,
          key,
          count: 1,
          confidenceSum: hopConfidence,
        });
      }
    }
    
    // Also consider src_hash → first path element
    // This captures the source node's connection to the first relay
    if (packet.src_hash && path.length > 0) {
      const firstPrefix = path[0];
      const firstResolved = resolveHop(firstPrefix, neighbors, localHash, neighborAffinity, false);
      
      // Source to first hop (src_hash is already a full hash)
      if (firstResolved.hash && 
          firstResolved.hash !== packet.src_hash &&
          firstResolved.confidence >= confidenceThreshold) {
        const key = makeEdgeKey(packet.src_hash, firstResolved.hash);
        const existing = accumulators.get(key);
        if (existing) {
          existing.count++;
          existing.confidenceSum += firstResolved.confidence;
        } else {
          accumulators.set(key, {
            fromHash: packet.src_hash,
            toHash: firstResolved.hash,
            key,
            count: 1,
            confidenceSum: firstResolved.confidence,
          });
        }
      }
    }
    
    // Last path element → local node connection
    // If last prefix matches local, the second-to-last is connected to local
    if (localHash && localPrefix && path.length >= 1) {
      const lastPrefix = path[path.length - 1];
      if (lastPrefix.toUpperCase() === localPrefix) {
        // Last hop is us - create edge from second-to-last to local
        if (path.length >= 2) {
          const penultimatePrefix = path[path.length - 2];
          const penultimateResolved = resolveHop(penultimatePrefix, neighbors, localHash, neighborAffinity, false);
          
          if (penultimateResolved.hash && 
              penultimateResolved.hash !== localHash &&
              penultimateResolved.confidence >= confidenceThreshold) {
            const key = makeEdgeKey(penultimateResolved.hash, localHash);
            const existing = accumulators.get(key);
            if (existing) {
              existing.count++;
              existing.confidenceSum += penultimateResolved.confidence;
            } else {
              accumulators.set(key, {
                fromHash: penultimateResolved.hash,
                toHash: localHash,
                key,
                count: 1,
                confidenceSum: penultimateResolved.confidence,
              });
            }
          }
        } else if (packet.src_hash && packet.src_hash !== localHash) {
          // Single-element path ending with local = direct from src
          const key = makeEdgeKey(packet.src_hash, localHash);
          const existing = accumulators.get(key);
          if (existing) {
            existing.count++;
            existing.confidenceSum += 1; // High confidence for direct
          } else {
            accumulators.set(key, {
              fromHash: packet.src_hash,
              toHash: localHash,
              key,
              count: 1,
              confidenceSum: 1,
            });
          }
        }
      }
    }
  }
  
  // Convert accumulators to edges
  const edges: TopologyEdge[] = [];
  let maxPacketCount = 0;
  
  for (const acc of accumulators.values()) {
    const avgConfidence = acc.confidenceSum / acc.count;
    maxPacketCount = Math.max(maxPacketCount, acc.count);
    
    edges.push({
      fromHash: acc.fromHash,
      toHash: acc.toHash,
      key: acc.key,
      packetCount: acc.count,
      avgConfidence,
      // Strength will be calculated after we know max count
      strength: 0,
    });
  }
  
  // Calculate strength scores (normalized count × confidence)
  for (const edge of edges) {
    const normalizedCount = maxPacketCount > 0 ? edge.packetCount / maxPacketCount : 0;
    edge.strength = normalizedCount * edge.avgConfidence;
  }
  
  // Sort by strength descending
  edges.sort((a, b) => b.strength - a.strength);
  
  // Build lookup map
  const edgeMap = new Map(edges.map(e => [e.key, e]));
  
  return { edges, edgeMap, maxPacketCount, neighborAffinity: simpleAffinity, fullAffinity: neighborAffinity, localPrefix };
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
 * Green for strongest, transitioning to neutral for weaker.
 */
export function getEdgeColor(strength: number): string {
  if (strength >= 0.7) {
    // High strength: green
    return 'rgba(74, 222, 128, 0.8)'; // green-400
  } else if (strength >= 0.4) {
    // Medium strength: teal/cyan
    return 'rgba(34, 211, 238, 0.6)'; // cyan-400
  } else {
    // Lower strength (but still above threshold): white/neutral
    return 'rgba(255, 255, 255, 0.35)';
  }
}
