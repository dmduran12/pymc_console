/**
 * Sparkline Web Worker
 * 
 * Computes sparkline data for ALL nodes in a single pass through packets.
 * This is O(P) instead of O(N×P) where P = packets, N = nodes.
 * 
 * Key optimization: Iterate packets ONCE, bucket by node prefix as we go.
 */

import type { Packet } from '@/types/api';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants (must match NodeSparkline.tsx)
// ═══════════════════════════════════════════════════════════════════════════════

const BUCKET_HOURS = 6;  // 6-hour buckets
const MAX_BUCKETS = 28;  // 7 days = 28 buckets
const MS_PER_BUCKET = BUCKET_HOURS * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface SparklineDataPoint {
  idx: number;
  count: number;
  timestamp: number;
}

export interface SparklineWorkerRequest {
  type: 'compute';
  payload: {
    packets: Packet[];
    nodeHashes: string[];  // Full hashes (e.g., "0x19ABCDEF")
  };
}

export interface SparklineWorkerResponse {
  type: 'result';
  payload: {
    /** Serialized as [hash, dataPoints[]][] for postMessage */
    sparklineEntries: [string, SparklineDataPoint[]][];
  };
  computeTimeMs: number;
  packetCount: number;
  nodeCount: number;
}

export interface SparklineWorkerError {
  type: 'error';
  error: string;
}

export type SparklineWorkerMessage = SparklineWorkerResponse | SparklineWorkerError;

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Extract 2-char uppercase prefix from hash */
function getHashPrefix(hash: string): string {
  if (!hash) return '';
  // Handle "0xAB..." format
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2, 4).toUpperCase();
  }
  return hash.slice(0, 2).toUpperCase();
}

/** Parse path from packet (handles JSON string or array) */
function parsePath(rawPath: string | string[] | undefined | null): string[] | null {
  if (!rawPath) return null;
  
  if (Array.isArray(rawPath)) {
    return rawPath;
  }
  
  if (typeof rawPath === 'string') {
    try {
      const parsed = JSON.parse(rawPath);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Computation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute sparklines for ALL nodes in a SINGLE pass through packets.
 * 
 * Algorithm:
 * 1. Build prefix → full hash lookup from nodeHashes
 * 2. Iterate packets ONCE
 * 3. For each packet, check path hops against prefix lookup
 * 4. Bucket matching packets by time for each matched node
 */
function computeAllSparklines(
  packets: Packet[],
  nodeHashes: string[]
): Map<string, SparklineDataPoint[]> {
  const now = Date.now();
  const displayStart = now - SEVEN_DAYS_MS;
  
  // Build prefix → Set<fullHash> lookup (handles collisions)
  const prefixToHashes = new Map<string, Set<string>>();
  for (const hash of nodeHashes) {
    const prefix = getHashPrefix(hash);
    if (!prefix) continue;
    
    if (!prefixToHashes.has(prefix)) {
      prefixToHashes.set(prefix, new Set());
    }
    prefixToHashes.get(prefix)!.add(hash);
  }
  
  // Accumulator: hash → bucketIdx → count
  // Also track earliest packet per node for proper left-alignment
  const nodeBuckets = new Map<string, Map<number, number>>();
  const nodeEarliest = new Map<string, number>();
  
  // Initialize for all nodes
  for (const hash of nodeHashes) {
    nodeBuckets.set(hash, new Map());
    nodeEarliest.set(hash, now);
  }
  
  // Single pass through packets
  for (const packet of packets) {
    const ts = packet.timestamp ?? 0;
    const normalizedTs = ts > 1e12 ? ts : ts * 1000; // Handle both ms and seconds
    
    // Skip packets outside display window
    if (normalizedTs < displayStart) continue;
    
    // Get involved prefixes from this packet
    const involvedPrefixes = new Set<string>();
    
    // Check path
    const rawPath = packet.forwarded_path ?? packet.original_path;
    const path = parsePath(rawPath);
    
    if (path && path.length > 0) {
      for (const hop of path) {
        const hopPrefix = String(hop).toUpperCase();
        if (prefixToHashes.has(hopPrefix)) {
          involvedPrefixes.add(hopPrefix);
        }
      }
    }
    
    // Check src_hash for direct packets (empty path)
    if ((!path || path.length === 0) && packet.src_hash) {
      const srcPrefix = getHashPrefix(packet.src_hash);
      if (prefixToHashes.has(srcPrefix)) {
        involvedPrefixes.add(srcPrefix);
      }
    }
    
    // Bucket this packet for all matched nodes
    if (involvedPrefixes.size > 0) {
      const bucketIdx = Math.floor((normalizedTs - displayStart) / MS_PER_BUCKET);
      const clampedIdx = Math.max(0, Math.min(MAX_BUCKETS - 1, bucketIdx));
      
      for (const prefix of involvedPrefixes) {
        const hashes = prefixToHashes.get(prefix)!;
        for (const hash of hashes) {
          const buckets = nodeBuckets.get(hash)!;
          buckets.set(clampedIdx, (buckets.get(clampedIdx) || 0) + 1);
          
          // Track earliest
          const earliest = nodeEarliest.get(hash)!;
          if (normalizedTs < earliest) {
            nodeEarliest.set(hash, normalizedTs);
          }
        }
      }
    }
  }
  
  // Convert to SparklineDataPoint arrays
  const result = new Map<string, SparklineDataPoint[]>();
  
  for (const hash of nodeHashes) {
    const buckets = nodeBuckets.get(hash)!;
    const earliest = nodeEarliest.get(hash)!;
    
    // Check if any data
    if (buckets.size === 0) {
      result.set(hash, []);
      continue;
    }
    
    // Determine start bucket (don't fill empty left side)
    const startBucketIdx = Math.max(0, Math.floor((earliest - displayStart) / MS_PER_BUCKET));
    
    // Build data points
    const dataPoints: SparklineDataPoint[] = [];
    for (let i = startBucketIdx; i < MAX_BUCKETS; i++) {
      dataPoints.push({
        idx: i - startBucketIdx,
        count: buckets.get(i) || 0,
        timestamp: displayStart + (i * MS_PER_BUCKET),
      });
    }
    
    result.set(hash, dataPoints);
  }
  
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = (event: MessageEvent<SparklineWorkerRequest>) => {
  const { type, payload } = event.data;
  
  if (type !== 'compute') {
    self.postMessage({ type: 'error', error: `Unknown message type: ${type}` });
    return;
  }
  
  const startTime = performance.now();
  
  try {
    const { packets, nodeHashes } = payload;
    
    const sparklines = computeAllSparklines(packets, nodeHashes);
    
    const computeTimeMs = performance.now() - startTime;
    
    const response: SparklineWorkerResponse = {
      type: 'result',
      payload: {
        sparklineEntries: Array.from(sparklines.entries()),
      },
      computeTimeMs,
      packetCount: packets.length,
      nodeCount: nodeHashes.length,
    };
    
    self.postMessage(response);
  } catch (error) {
    const errorResponse: SparklineWorkerError = {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error in sparkline worker',
    };
    self.postMessage(errorResponse);
  }
};
