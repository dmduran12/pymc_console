/**
 * Topology Web Worker
 * 
 * Runs expensive mesh topology analysis off the main thread.
 * Receives packets and neighbor data, returns computed topology.
 */

import type { Packet, NeighborInfo } from '@/types/api';
import { buildMeshTopology, type MeshTopology, type NeighborAffinity, type NetworkLoop, type TxDelayRecommendation, type NodeMobility, type PathHealth, type LastHopNeighbor } from '@/lib/mesh-topology';
import { serializePathRegistry, type SerializedPathRegistry } from '@/lib/path-registry';

// Message types
export interface TopologyWorkerRequest {
  type: 'compute';
  payload: {
    packets: Packet[];
    neighbors: Record<string, NeighborInfo>;
    localHash?: string;
    localLat?: number;
    localLon?: number;
    /** Estimated airtime in ms for a typical packet (from radio config) */
    airtimeMs?: number;
  };
}

// Serializable version of MeshTopology (Maps/Sets converted to arrays)
export interface SerializedTopology {
  edges: MeshTopology['edges'];
  validatedEdges: MeshTopology['validatedEdges'];
  weakEdges: MeshTopology['weakEdges'];
  certainEdges: MeshTopology['certainEdges'];
  uncertainEdges: MeshTopology['uncertainEdges'];
  maxPacketCount: number;
  maxCertainCount: number;
  localPrefix: string | null;
  hubNodes: string[];
  // Maps serialized as arrays of [key, value] tuples
  edgeMapEntries: [string, MeshTopology['edges'][0]][];
  neighborAffinityEntries: [string, number][];
  fullAffinityEntries: [string, NeighborAffinity][];
  centralityEntries: [string, number][];
  // Loop detection results
  loops: NetworkLoop[];
  loopEdgeKeyEntries: string[]; // Set serialized as array
  // TX delay recommendations for hub nodes
  txDelayRecommendationEntries: [string, TxDelayRecommendation][];
  // Phase 2: Path registry
  pathRegistry: SerializedPathRegistry;
  // Phase 4: Edge betweenness
  edgeBetweennessEntries: [string, number][];
  backboneEdges: string[];
  // Phase 5: Mobile repeater detection
  nodeMobilityEntries: [string, NodeMobility][];
  mobileNodes: string[];
  // Phase 7: Path health indicators
  pathHealth: PathHealth[];
  // Last-hop neighbors (ground truth from packet paths)
  lastHopNeighbors: LastHopNeighbor[];
}

export interface TopologyWorkerResponse {
  type: 'result';
  payload: SerializedTopology;
  computeTimeMs: number;
}

export interface TopologyWorkerError {
  type: 'error';
  error: string;
}

export type TopologyWorkerMessage = TopologyWorkerResponse | TopologyWorkerError;

// Worker message handler
self.onmessage = (event: MessageEvent<TopologyWorkerRequest>) => {
  const { type, payload } = event.data;
  
  if (type !== 'compute') {
    self.postMessage({ type: 'error', error: `Unknown message type: ${type}` });
    return;
  }
  
  const startTime = performance.now();
  
  try {
    const { packets, neighbors, localHash, localLat, localLon, airtimeMs } = payload;
    
    // Run the expensive computation
    // Use default confidence threshold (0.5) to capture more topology
    // Edge certainty is now determined by disambiguation confidence, not this threshold
    const topology = buildMeshTopology(
      packets,
      neighbors,
      localHash,
      0.5, // confidenceThreshold - lower to capture uncertain edges too
      localLat,
      localLon,
      airtimeMs
    );
    
    // Serialize Maps/Sets for postMessage (Maps/Sets aren't transferable)
    const serialized: SerializedTopology = {
      edges: topology.edges,
      validatedEdges: topology.validatedEdges,
      weakEdges: topology.weakEdges,
      certainEdges: topology.certainEdges,
      uncertainEdges: topology.uncertainEdges,
      maxPacketCount: topology.maxPacketCount,
      maxCertainCount: topology.maxCertainCount,
      localPrefix: topology.localPrefix,
      hubNodes: topology.hubNodes,
      edgeMapEntries: Array.from(topology.edgeMap.entries()),
      neighborAffinityEntries: Array.from(topology.neighborAffinity.entries()),
      fullAffinityEntries: Array.from(topology.fullAffinity.entries()),
      centralityEntries: Array.from(topology.centrality.entries()),
      loops: topology.loops,
      loopEdgeKeyEntries: Array.from(topology.loopEdgeKeys),
      txDelayRecommendationEntries: Array.from(topology.txDelayRecommendations.entries()),
      // Phase 2: Path registry
      pathRegistry: serializePathRegistry(topology.pathRegistry),
      // Phase 4: Edge betweenness
      edgeBetweennessEntries: Array.from(topology.edgeBetweenness.entries()),
      backboneEdges: topology.backboneEdges,
      // Phase 5: Mobile repeater detection
      nodeMobilityEntries: Array.from(topology.nodeMobility.entries()),
      mobileNodes: topology.mobileNodes,
      // Phase 7: Path health indicators
      pathHealth: topology.pathHealth,
      // Last-hop neighbors (ground truth from packet paths)
      lastHopNeighbors: topology.lastHopNeighbors,
    };
    
    const computeTimeMs = performance.now() - startTime;
    
    const response: TopologyWorkerResponse = {
      type: 'result',
      payload: serialized,
      computeTimeMs,
    };
    
    self.postMessage(response);
  } catch (error) {
    const errorResponse: TopologyWorkerError = {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error in topology worker',
    };
    self.postMessage(errorResponse);
  }
};
