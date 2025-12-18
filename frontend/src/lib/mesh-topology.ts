/**
 * Mesh Topology Analysis
 * 
 * Analyzes packet paths to build a network graph with confidence-weighted edges.
 * Uses probabilistic prefix matching (2-char hex prefixes have 256 possible values).
 * Only creates edges when confidence meets the threshold (default 80%).
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
}

interface EdgeAccumulator {
  fromHash: string;
  toHash: string;
  key: string;
  count: number;
  confidenceSum: number;
}

/**
 * Match a 2-character prefix to known node hashes.
 * Returns matching hashes and the probability (1/k where k = match count).
 */
function matchPrefix(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string
): { matches: string[]; probability: number } {
  const normalizedPrefix = prefix.toUpperCase();
  const matches: string[] = [];
  
  // Check local node
  if (localHash && localHash.toUpperCase().startsWith(normalizedPrefix)) {
    matches.push(localHash);
  }
  
  // Check neighbors
  for (const hash of Object.keys(neighbors)) {
    if (hash.toUpperCase().startsWith(normalizedPrefix)) {
      matches.push(hash);
    }
  }
  
  return {
    matches,
    probability: matches.length > 0 ? 1 / matches.length : 0,
  };
}

/**
 * Calculate confidence for a single hop in a path.
 * Returns the resolved hash (if unique) and the confidence score.
 */
function resolveHop(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localHash?: string
): { hash: string | null; confidence: number } {
  const { matches, probability } = matchPrefix(prefix, neighbors, localHash);
  
  if (matches.length === 1) {
    // Exact match - 100% confidence
    return { hash: matches[0], confidence: 1 };
  } else if (matches.length > 1) {
    // Multiple matches - confidence = 1/k
    // For topology, we take the first match but note reduced confidence
    return { hash: matches[0], confidence: probability };
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
      
      // Resolve both ends of this hop
      const fromResolved = resolveHop(fromPrefix, neighbors, localHash);
      const toResolved = resolveHop(toPrefix, neighbors, localHash);
      
      // Skip if either end couldn't be resolved
      if (!fromResolved.hash || !toResolved.hash) continue;
      
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
    
    // Also consider src_hash → first path element and last path element → destination
    // This captures the full route including source and destination
    if (packet.src_hash && path.length > 0) {
      const firstPrefix = path[0];
      const firstResolved = resolveHop(firstPrefix, neighbors, localHash);
      
      // Source to first hop (src_hash is already a full hash)
      if (firstResolved.hash && firstResolved.confidence >= confidenceThreshold) {
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
  
  return { edges, edgeMap, maxPacketCount };
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
