/**
 * Topology Service
 * 
 * Manages the topology Web Worker, providing a clean API for:
 * - Computing topology off main thread
 * - Debouncing rapid updates
 * - Notifying listeners when topology changes
 */

import type { Packet, NeighborInfo } from '@/types/api';
import type { MeshTopology, NeighborAffinity, TopologyEdge, NetworkLoop, TxDelayRecommendation, NodeMobility, PathHealth } from '@/lib/mesh-topology';
import { deserializePathRegistry, createEmptyPathRegistry, type PathRegistry, type ObservedPath } from '@/lib/path-registry';
import type { 
  TopologyWorkerRequest, 
  TopologyWorkerMessage, 
  SerializedTopology 
} from '@/lib/workers/topology.worker';

// Re-export for consumers
export type { MeshTopology, NeighborAffinity, TopologyEdge, NetworkLoop, TxDelayRecommendation, PathRegistry, ObservedPath, NodeMobility, PathHealth };

/** Listener for topology changes */
export type TopologyListener = (topology: MeshTopology, computeTimeMs: number) => void;

/** Deserialize worker response back to MeshTopology with Maps/Sets */
function deserializeTopology(serialized: SerializedTopology): MeshTopology {
  return {
    edges: serialized.edges ?? [],
    validatedEdges: serialized.validatedEdges ?? [],
    weakEdges: serialized.weakEdges ?? [],
    certainEdges: serialized.certainEdges ?? [],
    uncertainEdges: serialized.uncertainEdges ?? [],
    maxPacketCount: serialized.maxPacketCount ?? 0,
    maxCertainCount: serialized.maxCertainCount ?? 0,
    localPrefix: serialized.localPrefix ?? null,
    hubNodes: serialized.hubNodes ?? [],
    edgeMap: new Map(serialized.edgeMapEntries ?? []),
    neighborAffinity: new Map(serialized.neighborAffinityEntries ?? []),
    fullAffinity: new Map(serialized.fullAffinityEntries ?? []),
    centrality: new Map(serialized.centralityEntries ?? []),
    loops: serialized.loops ?? [],
    loopEdgeKeys: new Set(serialized.loopEdgeKeyEntries ?? []),
    txDelayRecommendations: new Map(serialized.txDelayRecommendationEntries ?? []),
    // Phase 2: Path registry
    pathRegistry: serialized.pathRegistry 
      ? deserializePathRegistry(serialized.pathRegistry) 
      : createEmptyPathRegistry(),
    // Phase 4: Edge betweenness
    edgeBetweenness: new Map(serialized.edgeBetweennessEntries ?? []),
    backboneEdges: serialized.backboneEdges ?? [],
    // Phase 5: Mobile repeater detection
    nodeMobility: new Map(serialized.nodeMobilityEntries ?? []),
    mobileNodes: serialized.mobileNodes ?? [],
    // Phase 7: Path health indicators
    pathHealth: serialized.pathHealth ?? [],
  };
}

/** Empty topology for initial state */
function createEmptyTopology(): MeshTopology {
  return {
    edges: [],
    validatedEdges: [],
    weakEdges: [],
    certainEdges: [],
    uncertainEdges: [],
    edgeMap: new Map(),
    maxPacketCount: 0,
    maxCertainCount: 0,
    neighborAffinity: new Map(),
    fullAffinity: new Map(),
    localPrefix: null,
    centrality: new Map(),
    hubNodes: [],
    loops: [],
    loopEdgeKeys: new Set(),
    txDelayRecommendations: new Map(),
    // Phase 2: Path registry
    pathRegistry: createEmptyPathRegistry(),
    // Phase 4: Edge betweenness
    edgeBetweenness: new Map(),
    backboneEdges: [],
    // Phase 5: Mobile repeater detection
    nodeMobility: new Map(),
    mobileNodes: [],
    // Phase 7: Path health indicators
    pathHealth: [],
  };
}

class TopologyService {
  private worker: Worker | null = null;
  private listeners: Set<TopologyListener> = new Set();
  private currentTopology: MeshTopology = createEmptyTopology();
  private isComputing = false;
  private pendingRequest: TopologyWorkerRequest['payload'] | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 100; // Debounce rapid updates
  
  constructor() {
    this.initWorker();
  }
  
  private initWorker(): void {
    if (typeof window === 'undefined') return; // SSR guard
    
    try {
      // Vite's native worker syntax
      this.worker = new Worker(
        new URL('./workers/topology.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      this.worker.onmessage = (event: MessageEvent<TopologyWorkerMessage>) => {
        this.handleWorkerMessage(event.data);
      };
      
      this.worker.onerror = (error) => {
        console.error('[TopologyService] Worker error:', error);
      };
    } catch (error) {
      console.error('[TopologyService] Failed to initialize worker:', error);
    }
  }
  
  private handleWorkerMessage(message: TopologyWorkerMessage): void {
    this.isComputing = false;
    
    if (message.type === 'error') {
      console.error('[TopologyService] Worker computation error:', message.error);
      return;
    }
    
    // Deserialize and store result
    this.currentTopology = deserializeTopology(message.payload);
    
    // DEBUG: Log topology stats including edges touching local
    const localPrefix = this.currentTopology.localPrefix;
    // Find edges where fromHash or toHash IS the local node (0x19 or full hash starting with 0x)
    const localEdges = this.currentTopology.edges.filter(e => 
      e.fromHash.startsWith('0x') || e.toHash.startsWith('0x')
    );
    // Also check for edges where neighbor's prefix matches local
    const allEdgesWithPrefix = localPrefix ? this.currentTopology.edges.filter(e => {
      const fromPrefix = e.fromHash.startsWith('0x') ? e.fromHash.slice(2).toUpperCase() : e.fromHash.slice(0, 2).toUpperCase();
      const toPrefix = e.toHash.startsWith('0x') ? e.toHash.slice(2).toUpperCase() : e.toHash.slice(0, 2).toUpperCase();
      return fromPrefix === localPrefix.toUpperCase() || toPrefix === localPrefix.toUpperCase();
    }) : [];
    console.log(`[TopologyService] Computed in ${message.computeTimeMs.toFixed(0)}ms:`, {
      totalEdges: this.currentTopology.edges.length,
      validatedEdges: this.currentTopology.validatedEdges.length,
      hubNodes: this.currentTopology.hubNodes.length,
      localPrefix,
      edgesWithLocalHash: localEdges.length,
      edgesWithLocalPrefix: allEdgesWithPrefix.length,
      localEdgeSample: localEdges.slice(0, 5).map(e => ({
        from: e.fromHash,
        to: e.toHash,
        certainCount: e.certainCount,
        validated: e.certainCount >= 5,
      })),
      prefixEdgeSample: allEdgesWithPrefix.slice(0, 5).map(e => ({
        from: e.fromHash,
        to: e.toHash,
        certainCount: e.certainCount,
        validated: e.certainCount >= 5,
      })),
    });
    
    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(this.currentTopology, message.computeTimeMs);
      } catch (error) {
        console.error('[TopologyService] Listener error:', error);
      }
    }
    
    // Process pending request if any
    if (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      this.computeInternal(request);
    }
  }
  
  private computeInternal(payload: TopologyWorkerRequest['payload']): void {
    if (!this.worker) {
      console.warn('[TopologyService] Worker not available');
      return;
    }
    
    this.isComputing = true;
    
    const request: TopologyWorkerRequest = {
      type: 'compute',
      payload,
    };
    
    this.worker.postMessage(request);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Request topology computation.
   * Automatically debounces rapid calls and queues if worker is busy.
   */
  compute(
    packets: Packet[],
    neighbors: Record<string, NeighborInfo>,
    localHash?: string,
    localLat?: number,
    localLon?: number
  ): void {
    const payload: TopologyWorkerRequest['payload'] = {
      packets,
      neighbors,
      localHash,
      localLat,
      localLon,
    };
    
    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // Debounce rapid updates
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      
      if (this.isComputing) {
        // Worker is busy — queue this request
        this.pendingRequest = payload;
      } else {
        this.computeInternal(payload);
      }
    }, this.debounceMs);
  }
  
  /**
   * Subscribe to topology changes.
   * Returns unsubscribe function.
   */
  subscribe(listener: TopologyListener): () => void {
    this.listeners.add(listener);
    
    // Immediately notify with current topology if we have data
    if (this.currentTopology.edges.length > 0) {
      listener(this.currentTopology, 0);
    }
    
    return () => {
      this.listeners.delete(listener);
    };
  }
  
  /**
   * Get current topology (synchronous).
   */
  getTopology(): MeshTopology {
    return this.currentTopology;
  }
  
  /**
   * Check if worker is currently computing.
   */
  isWorking(): boolean {
    return this.isComputing;
  }
  
  /**
   * Terminate worker (cleanup).
   */
  terminate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.listeners.clear();
  }
}

// Singleton instance
export const topologyService = new TopologyService();
