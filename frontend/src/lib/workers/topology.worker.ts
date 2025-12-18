/**
 * Topology Web Worker
 * 
 * Runs expensive mesh topology analysis off the main thread.
 * Receives packets and neighbor data, returns computed topology.
 */

import type { Packet, NeighborInfo } from '@/types/api';
import { buildMeshTopology, type MeshTopology, type NeighborAffinity } from '@/lib/mesh-topology';

// Message types
export interface TopologyWorkerRequest {
  type: 'compute';
  payload: {
    packets: Packet[];
    neighbors: Record<string, NeighborInfo>;
    localHash?: string;
    localLat?: number;
    localLon?: number;
  };
}

// Serializable version of MeshTopology (Maps converted to arrays)
export interface SerializedTopology {
  edges: MeshTopology['edges'];
  validatedEdges: MeshTopology['validatedEdges'];
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
    const { packets, neighbors, localHash, localLat, localLon } = payload;
    
    // Run the expensive computation
    const topology = buildMeshTopology(
      packets,
      neighbors,
      localHash,
      0.8, // confidenceThreshold
      localLat,
      localLon
    );
    
    // Serialize Maps for postMessage (Maps aren't transferable)
    const serialized: SerializedTopology = {
      edges: topology.edges,
      validatedEdges: topology.validatedEdges,
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
