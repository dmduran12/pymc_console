/**
 * Path Registry
 * 
 * Tracks complete path sequences through the mesh network.
 * Enables analysis of route patterns, canonical paths, and path evolution over time.
 * 
 * Key concepts:
 * - ObservedPath: A unique sequence of hops from source to destination
 * - PathRegistry: Collection of all observed paths with lookup by endpoints
 * - Canonical Path: The most-used path between a given source and destination
 */

import type { Packet } from '@/types/api';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * An observed path through the network.
 * Represents a unique sequence of hops from source to destination.
 */
export interface ObservedPath {
  /** Unique identifier - hash of the path sequence */
  id: string;
  
  /** Full path sequence: [A, B, C, D] where A is first hop, D is last */
  hops: string[];
  
  /** Source node hash (packet originator) */
  srcHash: string;
  
  /** Destination/local node hash (where packet was received) */
  dstHash: string;
  
  /** Number of times this exact path was observed */
  observationCount: number;
  
  /** First time this path was seen (unix ms) */
  firstSeen: number;
  
  /** Last time this path was seen (unix ms) */
  lastSeen: number;
  
  /** Whether this path was used for flood or direct routing */
  routeType: 'flood' | 'direct' | 'unknown';
  
  /** Number of hops (path length) */
  hopCount: number;
}

/**
 * Registry of all observed paths with efficient lookup.
 */
export interface PathRegistry {
  /** All observed paths */
  paths: ObservedPath[];
  
  /** Paths indexed by endpoint pair: "srcHash→dstHash" → paths */
  byEndpoints: Map<string, ObservedPath[]>;
  
  /** Most-used path for each endpoint pair */
  canonicalPaths: Map<string, ObservedPath>;
  
  /** Total number of path observations processed */
  totalObservations: number;
  
  /** Number of unique paths */
  uniquePathCount: number;
}

/**
 * Serializable version of PathRegistry for worker transfer.
 */
export interface SerializedPathRegistry {
  paths: ObservedPath[];
  byEndpointsEntries: [string, ObservedPath[]][];
  canonicalPathsEntries: [string, ObservedPath][];
  totalObservations: number;
  uniquePathCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a unique ID for a path based on its hop sequence.
 * Uses a simple hash of the joined hops.
 */
function createPathId(hops: string[], srcHash: string): string {
  // Include source hash to differentiate paths from different origins
  const pathStr = `${srcHash}:${hops.join('>')}`;
  // Simple hash - just use the string itself as ID (it's already unique)
  // For production, could use a proper hash function
  return pathStr;
}

/**
 * Create an endpoint key for lookup: "srcHash→dstHash"
 */
function createEndpointKey(srcHash: string, dstHash: string): string {
  return `${srcHash}→${dstHash}`;
}

/**
 * Determine route type from packet's route field.
 * MeshCore: 0 = FLOOD, 1 = DIRECT, 2 = TRANSPORT
 */
function getRouteType(packet: Packet): 'flood' | 'direct' | 'unknown' {
  const route = packet.route ?? packet.route_type;
  if (route === 0) return 'flood';
  if (route === 1) return 'direct';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path Registry Builder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a path registry from packets.
 * 
 * @param packets - Packets to analyze
 * @param localHash - Local node's hash (destination for received packets)
 * @param resolvedPaths - Pre-resolved paths with full hashes (optional optimization)
 */
export function buildPathRegistry(
  packets: Packet[],
  localHash?: string,
): PathRegistry {
  const pathMap = new Map<string, ObservedPath>();
  const byEndpoints = new Map<string, ObservedPath[]>();
  let totalObservations = 0;
  
  for (const packet of packets) {
    // Skip packets without source or path
    if (!packet.src_hash) continue;
    
    // Get path from original_path or forwarded_path
    const rawPath = packet.original_path ?? packet.forwarded_path;
    if (!rawPath || !Array.isArray(rawPath) || rawPath.length === 0) continue;
    
    // Normalize path to uppercase 2-char prefixes
    const hops: string[] = rawPath.map(h => 
      typeof h === 'string' ? h.toUpperCase().slice(0, 2) : String(h).toUpperCase().slice(0, 2)
    );
    
    // Determine destination (local node for received packets)
    const dstHash = localHash || 'unknown';
    const srcHash = packet.src_hash;
    
    // Create path ID from the sequence
    const pathId = createPathId(hops, srcHash);
    
    // Get or create the observed path
    let observedPath = pathMap.get(pathId);
    
    if (!observedPath) {
      observedPath = {
        id: pathId,
        hops,
        srcHash,
        dstHash,
        observationCount: 0,
        firstSeen: packet.timestamp,
        lastSeen: packet.timestamp,
        routeType: getRouteType(packet),
        hopCount: hops.length,
      };
      pathMap.set(pathId, observedPath);
    }
    
    // Update observation stats
    observedPath.observationCount++;
    observedPath.lastSeen = Math.max(observedPath.lastSeen, packet.timestamp);
    observedPath.firstSeen = Math.min(observedPath.firstSeen, packet.timestamp);
    totalObservations++;
    
    // Update route type if this observation is direct (stronger signal)
    const currentRouteType = getRouteType(packet);
    if (currentRouteType === 'direct' && observedPath.routeType !== 'direct') {
      observedPath.routeType = 'direct';
    }
  }
  
  // Build paths array
  const paths = Array.from(pathMap.values());
  
  // Build byEndpoints index
  for (const path of paths) {
    const endpointKey = createEndpointKey(path.srcHash, path.dstHash);
    const existing = byEndpoints.get(endpointKey) || [];
    existing.push(path);
    byEndpoints.set(endpointKey, existing);
  }
  
  // Sort paths within each endpoint by observation count (descending)
  for (const pathList of byEndpoints.values()) {
    pathList.sort((a, b) => b.observationCount - a.observationCount);
  }
  
  // Build canonical paths (most-used path per endpoint pair)
  const canonicalPaths = new Map<string, ObservedPath>();
  for (const [endpointKey, pathList] of byEndpoints) {
    if (pathList.length > 0) {
      // First path is most-used (already sorted)
      canonicalPaths.set(endpointKey, pathList[0]);
    }
  }
  
  return {
    paths,
    byEndpoints,
    canonicalPaths,
    totalObservations,
    uniquePathCount: paths.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Serialization (for worker transfer)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Serialize PathRegistry for transfer to/from worker.
 */
export function serializePathRegistry(registry: PathRegistry): SerializedPathRegistry {
  return {
    paths: registry.paths,
    byEndpointsEntries: Array.from(registry.byEndpoints.entries()),
    canonicalPathsEntries: Array.from(registry.canonicalPaths.entries()),
    totalObservations: registry.totalObservations,
    uniquePathCount: registry.uniquePathCount,
  };
}

/**
 * Deserialize PathRegistry from worker transfer.
 */
export function deserializePathRegistry(serialized: SerializedPathRegistry): PathRegistry {
  return {
    paths: serialized.paths,
    byEndpoints: new Map(serialized.byEndpointsEntries),
    canonicalPaths: new Map(serialized.canonicalPathsEntries),
    totalObservations: serialized.totalObservations,
    uniquePathCount: serialized.uniquePathCount,
  };
}

/**
 * Create an empty path registry.
 */
export function createEmptyPathRegistry(): PathRegistry {
  return {
    paths: [],
    byEndpoints: new Map(),
    canonicalPaths: new Map(),
    totalObservations: 0,
    uniquePathCount: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path Analysis Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all paths between two endpoints.
 */
export function getPathsBetween(
  registry: PathRegistry,
  srcHash: string,
  dstHash: string
): ObservedPath[] {
  const key = createEndpointKey(srcHash, dstHash);
  return registry.byEndpoints.get(key) || [];
}

/**
 * Get the canonical (most-used) path between two endpoints.
 */
export function getCanonicalPath(
  registry: PathRegistry,
  srcHash: string,
  dstHash: string
): ObservedPath | undefined {
  const key = createEndpointKey(srcHash, dstHash);
  return registry.canonicalPaths.get(key);
}

/**
 * Get all paths that pass through a given node.
 */
export function getPathsThroughNode(
  registry: PathRegistry,
  nodeHash: string
): ObservedPath[] {
  // Check by prefix if it's a short hash
  const prefix = nodeHash.startsWith('0x') 
    ? nodeHash.slice(2, 4).toUpperCase()
    : nodeHash.slice(0, 2).toUpperCase();
  
  return registry.paths.filter(path => 
    path.hops.some(hop => 
      hop.toUpperCase() === prefix || 
      hop.toUpperCase().startsWith(prefix) ||
      hop === nodeHash
    )
  );
}

/**
 * Calculate path diversity for a node (how many distinct paths use it).
 */
export function getPathDiversity(
  registry: PathRegistry,
  nodeHash: string
): number {
  return getPathsThroughNode(registry, nodeHash).length;
}

/**
 * Get top N most-used paths overall.
 */
export function getTopPaths(
  registry: PathRegistry,
  n: number = 10
): ObservedPath[] {
  return [...registry.paths]
    .sort((a, b) => b.observationCount - a.observationCount)
    .slice(0, n);
}
