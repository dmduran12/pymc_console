/**
 * Topology Service
 * 
 * Manages the topology Web Worker, providing a clean API for:
 * - Computing topology off main thread
 * - Debouncing rapid updates
 * - Notifying listeners when topology changes
 */

import type { Packet, NeighborInfo } from '@/types/api';
import type { MeshTopology, NeighborAffinity, TopologyEdge } from '@/lib/mesh-topology';
import type { 
  TopologyWorkerRequest, 
  TopologyWorkerMessage, 
  SerializedTopology 
} from '@/lib/workers/topology.worker';

// Re-export for consumers
export type { MeshTopology, NeighborAffinity, TopologyEdge };

/** Listener for topology changes */
export type TopologyListener = (topology: MeshTopology, computeTimeMs: number) => void;

/** Deserialize worker response back to MeshTopology with Maps */
function deserializeTopology(serialized: SerializedTopology): MeshTopology {
  return {
    edges: serialized.edges,
    validatedEdges: serialized.validatedEdges,
    certainEdges: serialized.certainEdges,
    uncertainEdges: serialized.uncertainEdges,
    maxPacketCount: serialized.maxPacketCount,
    maxCertainCount: serialized.maxCertainCount,
    localPrefix: serialized.localPrefix,
    hubNodes: serialized.hubNodes,
    edgeMap: new Map(serialized.edgeMapEntries),
    neighborAffinity: new Map(serialized.neighborAffinityEntries),
    fullAffinity: new Map(serialized.fullAffinityEntries),
    centrality: new Map(serialized.centralityEntries),
  };
}

/** Empty topology for initial state */
function createEmptyTopology(): MeshTopology {
  return {
    edges: [],
    validatedEdges: [],
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
