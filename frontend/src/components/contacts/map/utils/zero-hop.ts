/**
 * Zero-Hop Neighbor Detection
 * 
 * Analyzes packets and topology to determine which neighbors are zero-hop
 * (direct RF contact with local node).
 */

import type { Packet, NeighborInfo } from '@/types/api';
import { parsePath, getHashPrefix } from '@/lib/path-utils';

/**
 * Analyze packets and topology to determine which neighbors are zero-hop (direct RF contact with local).
 * 
 * A neighbor is considered zero-hop if we've DIRECTLY received RF signal from them.
 * This is determined by:
 * 1. Topology edges with hopDistanceFromLocal === 0 (most reliable - uses disambiguation)
 * 2. Empty path AND src_hash matches - no forwarding, direct RF reception
 * 3. Path with single element (last forwarder) that matches a known neighbor
 * 
 * IMPORTANT: MeshCore route_type does NOT indicate hop count!
 * - DIRECT route (route=2) means "pre-computed path", NOT "zero-hop"
 * - A DIRECT-routed packet can have multiple hops with a predetermined path
 * - Zero-hop detection must use PATH LENGTH, not route type
 * 
 * The topology approach (method 1) is preferred because it uses the centralized
 * prefix disambiguation system which considers position consistency, co-occurrence patterns,
 * and geographic proximity to resolve prefix collisions.
 * 
 * @param packets - All received packets
 * @param neighbors - Known neighbors (to match prefixes to full hashes)
 * @param topologyEdges - Optional validated edges from topology (preferred for disambiguation)
 * @param localHash - Local node hash (for matching topology edges)
 * @returns Set of neighbor hashes that are zero-hop
 */
export function inferZeroHopNeighbors(
  packets: Packet[], 
  neighbors: Record<string, NeighborInfo>,
  topologyEdges?: { fromHash: string; toHash: string; hopDistanceFromLocal: number }[],
  localHash?: string
): Set<string> {
  const zeroHopNodes = new Set<string>();
  
  // Method 1: Use topology edges with hopDistanceFromLocal === 0
  // This is the most reliable method because it uses the disambiguation system
  if (topologyEdges && localHash) {
    for (const edge of topologyEdges) {
      if (edge.hopDistanceFromLocal === 0) {
        // This edge connects directly to local
        if (edge.fromHash === localHash && edge.toHash !== localHash) {
          zeroHopNodes.add(edge.toHash);
        } else if (edge.toHash === localHash && edge.fromHash !== localHash) {
          zeroHopNodes.add(edge.fromHash);
        }
      }
    }
  }
  
  // Build prefix -> full hash lookup for fallback prefix matching
  const prefixToHash = new Map<string, string[]>();
  for (const hash of Object.keys(neighbors)) {
    const prefix = getHashPrefix(hash);
    const existing = prefixToHash.get(prefix) || [];
    existing.push(hash);
    prefixToHash.set(prefix, existing);
  }
  
  for (const packet of packets) {
    // Skip if no source hash
    if (!packet.src_hash) continue;
    
    // Method 2: Empty/null path means we received directly from source (no relays)
    // This is TRUE zero-hop detection based on path absence
    const path = packet.forwarded_path ?? packet.original_path;
    if (!path || (Array.isArray(path) && path.length === 0)) {
      zeroHopNodes.add(packet.src_hash);
      continue;
    }
    
    // Method 3: (Fallback) The LAST non-local element in the path is the node that transmitted to us.
    // Only use this if we don't already have edges from topology
    // Note: This is less reliable for prefix collisions
    // Use centralized path parsing which handles local stripping
    if (Array.isArray(path) && path.length > 0 && (!topologyEdges || topologyEdges.length === 0)) {
      const parsed = parsePath(path, localHash);
      if (!parsed || parsed.effectiveLength === 0) continue;
      
      // Last element in effective path is the last forwarder (transmitted to us)
      const lastHopPrefix = parsed.effective[parsed.effectiveLength - 1];
      
      // Find neighbors matching this prefix
      const matchingHashes = prefixToHash.get(lastHopPrefix) || [];
      
      if (matchingHashes.length === 1) {
        // Unique match - we know exactly which neighbor forwarded to us
        zeroHopNodes.add(matchingHashes[0]);
      } else if (matchingHashes.length > 1) {
        // Multiple neighbors share this prefix - add all as candidates
        for (const hash of matchingHashes) {
          zeroHopNodes.add(hash);
        }
      }
    }
  }
  
  return zeroHopNodes;
}
