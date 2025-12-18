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
  /** Neighbor affinity scores (hash -> packet count received from that neighbor) */
  neighborAffinity: Map<string, number>;
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
 * Extract the 2-character prefix from a full hash.
 */
export function getHashPrefix(hash: string): string {
  return hash.slice(0, 2).toUpperCase();
}

/**
 * Check if a prefix matches a full hash.
 */
function prefixMatches(prefix: string, hash: string): boolean {
  return hash.toUpperCase().startsWith(prefix.toUpperCase());
}

/**
 * Build neighbor affinity map from packets.
 * Counts how many packets we've received where each neighbor appears as the last hop.
 * Higher counts = stronger/closer neighbors.
 */
function buildNeighborAffinity(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash?: string
): Map<string, number> {
  const affinity = new Map<string, number>();
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  
  for (const packet of packets) {
    const path = packet.forwarded_path ?? packet.original_path;
    
    // If path ends with local prefix, the second-to-last element is our direct neighbor
    if (path && path.length >= 2 && localPrefix) {
      const lastPrefix = path[path.length - 1];
      if (lastPrefix.toUpperCase() === localPrefix) {
        // Second-to-last is the neighbor that forwarded to us
        const neighborPrefix = path[path.length - 2];
        // Find matching neighbor hash
        for (const hash of Object.keys(neighbors)) {
          if (prefixMatches(neighborPrefix, hash)) {
            affinity.set(hash, (affinity.get(hash) || 0) + 1);
          }
        }
      }
    }
    
    // Also count direct packets (empty path or single-element path)
    if ((!path || path.length === 0) && packet.src_hash) {
      // Direct packet from src_hash
      if (neighbors[packet.src_hash]) {
        affinity.set(packet.src_hash, (affinity.get(packet.src_hash) || 0) + 1);
      }
    }
  }
  
  return affinity;
}

/**
 * Match a 2-character prefix to known node hashes.
 * Returns matching hashes and the probability (1/k where k = match count).
 * 
 * @param prefix - The 2-char hex prefix to match
 * @param neighbors - Known neighbors
 * @param localHash - Local node's full hash
 * @param neighborAffinity - Optional affinity map for tiebreaking
 * @param isLastHop - If true and prefix matches local, return local with high confidence
 */
function matchPrefix(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  neighborAffinity?: Map<string, number>,
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
  const probability = matches.length > 0 ? 1 / matches.length : 0;
  
  // Determine best match using affinity for tiebreaking
  let bestMatch: string | null = null;
  if (matches.length === 1) {
    bestMatch = matches[0];
  } else if (matches.length > 1 && neighborAffinity) {
    // Use affinity to pick the most likely candidate
    let bestAffinity = -1;
    for (const hash of matches) {
      const aff = neighborAffinity.get(hash) || 0;
      if (aff > bestAffinity) {
        bestAffinity = aff;
        bestMatch = hash;
      }
    }
    // If no affinity data, fall back to first match
    if (!bestMatch) bestMatch = matches[0];
  } else if (matches.length > 0) {
    bestMatch = matches[0];
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
 * @param neighborAffinity - Affinity map for tiebreaking
 * @param isLastHop - Whether this is the last element in the path
 */
function resolveHop(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  neighborAffinity?: Map<string, number>,
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
    // Multiple matches
    // If we have affinity data and a clear winner, boost confidence
    if (neighborAffinity && bestMatch) {
      const bestAffinity = neighborAffinity.get(bestMatch) || 0;
      const totalAffinity = matches.reduce((sum, h) => sum + (neighborAffinity.get(h) || 0), 0);
      
      if (totalAffinity > 0 && bestAffinity > 0) {
        // Confidence based on affinity ratio (capped at 0.95)
        const affinityConfidence = Math.min(0.95, bestAffinity / totalAffinity);
        return { hash: bestMatch, confidence: Math.max(probability, affinityConfidence) };
      }
    }
    
    // Fall back to probability
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
 * @returns MeshTopology with edges that meet the confidence threshold
 */
export function buildMeshTopology(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  confidenceThreshold: number = 0.8
): MeshTopology {
  // First pass: build neighbor affinity map for tiebreaking
  const neighborAffinity = buildNeighborAffinity(packets, neighbors, localHash);
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  
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
  
  return { edges, edgeMap, maxPacketCount, neighborAffinity, localPrefix };
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
