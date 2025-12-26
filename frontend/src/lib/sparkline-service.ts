/**
 * Sparkline Service
 * 
 * Manages the sparkline Web Worker, providing:
 * - Background pre-computation of ALL node sparklines
 * - Caching for instant synchronous access
 * - Progress tracking for UI feedback
 * 
 * Design: Computes all sparklines in a single worker call after packets load.
 * The worker does O(P) work instead of O(N×P).
 */

import type { Packet } from '@/types/api';
import type {
  SparklineWorkerRequest,
  SparklineWorkerMessage,
  SparklineDataPoint,
} from '@/lib/workers/sparkline.worker';

// Re-export types for consumers
export type { SparklineDataPoint };

/** Listener for sparkline computation updates */
export interface SparklineListener {
  (sparklines: Map<string, SparklineDataPoint[]>, isComputing: boolean): void;
}

class SparklineService {
  private worker: Worker | null = null;
  private listeners: Set<SparklineListener> = new Set();
  private sparklines: Map<string, SparklineDataPoint[]> = new Map();
  private isComputing = false;
  private lastComputeTimeMs = 0;
  private pendingRequest: { packets: Packet[]; nodeHashes: string[] } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 150; // Debounce rapid updates
  
  constructor() {
    this.initWorker();
  }
  
  private initWorker(): void {
    if (typeof window === 'undefined') return; // SSR guard
    
    try {
      this.worker = new Worker(
        new URL('./workers/sparkline.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      this.worker.onmessage = (event: MessageEvent<SparklineWorkerMessage>) => {
        this.handleWorkerMessage(event.data);
      };
      
      this.worker.onerror = (error) => {
        console.error('[SparklineService] Worker error:', error);
        this.isComputing = false;
        this.notifyListeners();
      };
    } catch (error) {
      console.error('[SparklineService] Failed to initialize worker:', error);
    }
  }
  
  private handleWorkerMessage(message: SparklineWorkerMessage): void {
    this.isComputing = false;
    
    if (message.type === 'error') {
      console.error('[SparklineService] Worker computation error:', message.error);
      this.notifyListeners();
      return;
    }
    
    // Store results
    this.sparklines = new Map(message.payload.sparklineEntries);
    this.lastComputeTimeMs = message.computeTimeMs;
    
    console.log(
      `[SparklineService] Computed ${message.nodeCount} sparklines from ${message.packetCount} packets in ${message.computeTimeMs.toFixed(0)}ms`
    );
    
    // Notify listeners
    this.notifyListeners();
    
    // Process pending request if any
    if (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      this.computeInternal(request.packets, request.nodeHashes);
    }
  }
  
  private computeInternal(packets: Packet[], nodeHashes: string[]): void {
    if (!this.worker) {
      console.warn('[SparklineService] Worker not available');
      return;
    }
    
    if (nodeHashes.length === 0) {
      // Nothing to compute
      this.isComputing = false;
      this.notifyListeners();
      return;
    }
    
    this.isComputing = true;
    this.notifyListeners();
    
    const request: SparklineWorkerRequest = {
      type: 'compute',
      payload: { packets, nodeHashes },
    };
    
    this.worker.postMessage(request);
  }
  
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.sparklines, this.isComputing);
      } catch (error) {
        console.error('[SparklineService] Listener error:', error);
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Compute sparklines for all nodes.
   * Debounces rapid calls and queues if worker is busy.
   */
  compute(packets: Packet[], nodeHashes: string[]): void {
    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // Debounce rapid updates
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      
      if (this.isComputing) {
        // Worker is busy — queue this request
        this.pendingRequest = { packets, nodeHashes };
      } else {
        this.computeInternal(packets, nodeHashes);
      }
    }, this.debounceMs);
  }
  
  /**
   * Get cached sparkline data for a node (synchronous).
   * Returns empty array if not yet computed.
   */
  getSparkline(nodeHash: string): SparklineDataPoint[] {
    return this.sparklines.get(nodeHash) ?? [];
  }
  
  /**
   * Get all cached sparklines (synchronous).
   */
  getAllSparklines(): Map<string, SparklineDataPoint[]> {
    return this.sparklines;
  }
  
  /**
   * Check if a specific node's sparkline is ready.
   */
  hasSparkline(nodeHash: string): boolean {
    return this.sparklines.has(nodeHash);
  }
  
  /**
   * Check if currently computing.
   */
  isWorking(): boolean {
    return this.isComputing;
  }
  
  /**
   * Get last computation time in ms.
   */
  getLastComputeTime(): number {
    return this.lastComputeTimeMs;
  }
  
  /**
   * Subscribe to sparkline updates.
   * Returns unsubscribe function.
   */
  subscribe(listener: SparklineListener): () => void {
    this.listeners.add(listener);
    
    // Immediately notify with current state
    listener(this.sparklines, this.isComputing);
    
    return () => {
      this.listeners.delete(listener);
    };
  }
  
  /**
   * Clear all cached sparklines.
   */
  clear(): void {
    this.sparklines.clear();
    this.notifyListeners();
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
export const sparklineService = new SparklineService();
