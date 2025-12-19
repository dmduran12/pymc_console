/**
 * Path Utilities
 * 
 * Centralized path parsing and normalization for MeshCore packet paths.
 * 
 * IMPORTANT: The `forwarded_path` from the API includes local's prefix at the end.
 * For example, a packet received through [78] → [24] → [local] has path ["78", "24", "19"]
 * where "19" is local's prefix.
 * 
 * Most processing needs the "effective" path (without local) so that:
 * - Position 1 = last forwarder (the node that transmitted to us)
 * - Position 2 = second-to-last hop
 * - etc.
 * 
 * This module provides a single source of truth for path parsing to prevent
 * the "local prefix in path" bug from recurring across multiple files.
 */

import type { Packet } from '@/types/api';

/**
 * Result of parsing a packet path.
 */
export interface ParsedPath {
  /** 
   * Effective path with local prefix removed from end.
   * Use this for position calculations where position 1 = last forwarder.
   */
  effective: string[];
  
  /** 
   * Original path as received (may include local at end).
   * Use this only when you need the raw data.
   */
  original: string[];
  
  /** Whether local's prefix was present at the end and stripped */
  hadLocal: boolean;
  
  /** Length of effective path (convenience) */
  effectiveLength: number;
}

/**
 * Extract the 2-character prefix from a hash.
 * Handles both "0xNN" format (local hash) and full hex strings (neighbor hashes).
 */
export function getHashPrefix(hash: string): string {
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2).toUpperCase();
  }
  return hash.slice(0, 2).toUpperCase();
}

/**
 * Parse and normalize a packet path.
 * 
 * This is the SINGLE SOURCE OF TRUTH for path parsing.
 * All path processing should use this function.
 * 
 * @param packet - The packet containing path data
 * @param localHash - Local node's hash (e.g., "0x19") - used to strip local from end
 * @returns ParsedPath or null if no valid path
 * 
 * @example
 * const parsed = parsePacketPath(packet, "0x19");
 * if (parsed) {
 *   // parsed.effective = ["78", "24"] (local stripped)
 *   // parsed.original = ["78", "24", "19"]
 *   // parsed.hadLocal = true
 *   // parsed.effectiveLength = 2
 * }
 */
export function parsePacketPath(
  packet: Packet,
  localHash?: string
): ParsedPath | null {
  // Get raw path from packet (prefer forwarded_path)
  let rawPath = packet.forwarded_path ?? packet.original_path;
  
  // Handle JSON string format
  if (typeof rawPath === 'string') {
    try {
      rawPath = JSON.parse(rawPath);
    } catch {
      return null; // Invalid JSON
    }
  }
  
  // Validate it's a non-empty array
  if (!rawPath || !Array.isArray(rawPath) || rawPath.length === 0) {
    return null;
  }
  
  // Normalize all prefixes to uppercase
  const original = rawPath.map(p => String(p).toUpperCase());
  
  // Calculate local prefix if hash provided
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  
  // Check if path ends with local's prefix
  const lastElement = original[original.length - 1];
  const hadLocal = localPrefix !== null && lastElement === localPrefix;
  
  // Create effective path (strip local if present)
  const effective = hadLocal ? original.slice(0, -1) : [...original];
  
  return {
    effective,
    original,
    hadLocal,
    effectiveLength: effective.length,
  };
}

/**
 * Parse a raw path array (not from packet).
 * Use this when you already have a path array but need normalization.
 * 
 * @param path - Raw path array (may be JSON string or array)
 * @param localHash - Local node's hash for stripping
 */
export function parsePath(
  path: string[] | string | null | undefined,
  localHash?: string
): ParsedPath | null {
  // Handle JSON string format
  let rawPath = path;
  if (typeof rawPath === 'string') {
    try {
      rawPath = JSON.parse(rawPath);
    } catch {
      return null;
    }
  }
  
  if (!rawPath || !Array.isArray(rawPath) || rawPath.length === 0) {
    return null;
  }
  
  // Normalize
  const original = rawPath.map(p => String(p).toUpperCase());
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  const lastElement = original[original.length - 1];
  const hadLocal = localPrefix !== null && lastElement === localPrefix;
  const effective = hadLocal ? original.slice(0, -1) : [...original];
  
  return {
    effective,
    original,
    hadLocal,
    effectiveLength: effective.length,
  };
}

/**
 * Calculate the position of an element in the effective path.
 * Position 1 = last forwarder (closest to local), 2 = second-to-last, etc.
 * 
 * @param index - 0-based index in effective path
 * @param effectiveLength - Length of effective path
 * @returns 1-indexed position from the end
 */
export function getPositionFromIndex(index: number, effectiveLength: number): number {
  return effectiveLength - index;
}

/**
 * Calculate hop distance from local for an edge.
 * 
 * @param toPosition - Position of the "to" node (1 = last forwarder)
 * @returns Hop distance (0 = edge touches local, 1 = one hop away, etc.)
 * 
 * Note: The edge from last forwarder TO local has hopDistance=0.
 * The edge TO the last forwarder has hopDistance=1 (since toPosition=1).
 */
export function getHopDistanceFromLocal(toPosition: number): number {
  // Edge connecting TO position 1 (last forwarder) is 1 hop from local
  // Edge connecting TO position 2 is 2 hops from local
  // etc.
  return toPosition;
}

/**
 * Check if a prefix matches a hash.
 */
export function prefixMatches(prefix: string, hash: string): boolean {
  const normalizedPrefix = prefix.toUpperCase();
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2).toUpperCase().startsWith(normalizedPrefix);
  }
  return hash.toUpperCase().startsWith(normalizedPrefix);
}
