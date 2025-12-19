/**
 * Prefix Disambiguation System
 * 
 * Resolves 2-character hex prefix collisions in MeshCore packet paths.
 * With 180+ neighbors and only 256 possible prefixes, collisions are inevitable.
 * 
 * This module provides a centralized disambiguation service using three factors:
 * 1. Path Position Consistency - Where does this node typically appear in paths?
 * 2. Co-occurrence Frequency - How often does this prefix appear alongside others?
 * 3. Geographic Path Coherence - Does the candidate's location make sense?
 * 
 * Usage:
 *   const lookup = buildPrefixLookup(packets, neighbors, localHash, localLat, localLon);
 *   const { hash, confidence } = resolvePrefix(lookup, "24");
 */

import type { Packet, NeighborInfo } from '@/types/api';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Statistics for a single candidate matching a prefix */
export interface DisambiguationCandidate {
  /** Full hash of the candidate node */
  hash: string;
  /** 2-char prefix this candidate matches */
  prefix: string;
  
  // ─── Path Position Scoring ───────────────────────────────────────────────────
  /** Count of appearances at each position [1-hop, 2-hop, 3-hop, 4-hop, 5-hop] */
  positionCounts: number[];
  /** Total appearances across all positions */
  totalAppearances: number;
  /** Most common position (1 = direct forwarder, 2 = 2-hop, etc.) */
  typicalPosition: number;
  /** 0-1: How concentrated appearances are at typical position */
  positionConsistency: number;
  
  // ─── Co-occurrence Scoring ───────────────────────────────────────────────────
  /** Map of adjacent prefix -> count of times seen adjacent to this candidate */
  adjacentPrefixCounts: Map<string, number>;
  /** Total count of adjacent observations */
  totalAdjacentObservations: number;
  
  // ─── Geographic Scoring ──────────────────────────────────────────────────────
  /** Latitude (if known) */
  latitude?: number;
  /** Longitude (if known) */
  longitude?: number;
  /** Distance to local node in meters (if calculable) */
  distanceToLocal?: number;
  
  // ─── Combined Scores ─────────────────────────────────────────────────────────
  /** 0-1: Score based on path position consistency */
  positionScore: number;
  /** 0-1: Score based on co-occurrence patterns */
  cooccurrenceScore: number;
  /** 0-1: Score based on geographic plausibility */
  geographicScore: number;
  /** 0-1: Weighted combination of all scores */
  combinedScore: number;
}

/** Result of disambiguating a single prefix */
export interface DisambiguationResult {
  /** The 2-char prefix being disambiguated */
  prefix: string;
  /** All candidates matching this prefix, sorted by combinedScore desc */
  candidates: DisambiguationCandidate[];
  /** Full hash of best candidate (highest combinedScore), or null if no candidates */
  bestMatch: string | null;
  /** 0-1: Confidence in bestMatch (based on score separation from runner-up) */
  confidence: number;
  /** True if only one candidate matches (100% certain) */
  isUnambiguous: boolean;
  /** Best match for specific positions (may differ from global best) */
  bestMatchForPosition: Map<number, { hash: string; confidence: number }>;
}

/** Complete lookup table for all prefixes */
export type PrefixLookup = Map<string, DisambiguationResult>;

/** Context for position-aware resolution */
export interface ResolutionContext {
  /** Position in path (1 = last hop/direct forwarder, 2 = 2-hop, etc.) */
  position?: number;
  /** Adjacent prefixes in the path (for co-occurrence boost) */
  adjacentPrefixes?: string[];
  /** Whether this is known to be the last hop (direct to local) */
  isLastHop?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Weights for combining scores */
const SCORE_WEIGHTS = {
  position: 0.35,
  cooccurrence: 0.35,
  geographic: 0.30,
};

/** Maximum hop positions to track */
const MAX_POSITIONS = 5;

/** Expected max distance for a single RF hop (meters) - for geographic scoring */
const EXPECTED_MAX_HOP_DISTANCE = 50000; // 50km

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

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
 * Check if a prefix matches a hash.
 */
export function prefixMatches(prefix: string, hash: string): boolean {
  const normalizedPrefix = prefix.toUpperCase();
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2).toUpperCase().startsWith(normalizedPrefix);
  }
  return hash.toUpperCase().startsWith(normalizedPrefix);
}

/**
 * Calculate distance between two coordinates in meters using Haversine formula.
 */
function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parse path from packet (handles JSON string or array).
 */
function parsePath(packet: Packet): string[] | null {
  let path = packet.forwarded_path ?? packet.original_path;
  
  if (typeof path === 'string') {
    try {
      path = JSON.parse(path);
    } catch {
      return null;
    }
  }
  
  if (!path || !Array.isArray(path) || path.length === 0) {
    return null;
  }
  
  return path.map(p => String(p).toUpperCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a prefix lookup table from packets and neighbors.
 * This is the main entry point for disambiguation.
 * 
 * @param packets - All packets to analyze
 * @param neighbors - Known neighbors with location data
 * @param localHash - Local node's hash (e.g., "0x19")
 * @param localLat - Local node latitude
 * @param localLon - Local node longitude
 * @returns PrefixLookup - Map from prefix to disambiguation result
 */
export function buildPrefixLookup(
  packets: Packet[],
  neighbors: Record<string, NeighborInfo>,
  localHash?: string,
  localLat?: number,
  localLon?: number
): PrefixLookup {
  const lookup: PrefixLookup = new Map();
  
  // ─── Step 1: Build prefix -> candidates mapping ──────────────────────────────
  const prefixToCandidates = new Map<string, DisambiguationCandidate[]>();
  const hasLocalCoords = localLat !== undefined && localLon !== undefined &&
    (localLat !== 0 || localLon !== 0);
  
  // Add local node if hash provided
  if (localHash) {
    const localPrefix = getHashPrefix(localHash);
    const candidate: DisambiguationCandidate = {
      hash: localHash,
      prefix: localPrefix,
      positionCounts: new Array(MAX_POSITIONS).fill(0),
      totalAppearances: 0,
      typicalPosition: 0,
      positionConsistency: 0,
      adjacentPrefixCounts: new Map(),
      totalAdjacentObservations: 0,
      latitude: localLat,
      longitude: localLon,
      distanceToLocal: 0,
      positionScore: 0,
      cooccurrenceScore: 0,
      geographicScore: 1.0, // Local is always at distance 0
      combinedScore: 0,
    };
    prefixToCandidates.set(localPrefix, [candidate]);
  }
  
  // Add all neighbors
  for (const [hash, neighbor] of Object.entries(neighbors)) {
    const prefix = getHashPrefix(hash);
    
    let distanceToLocal: number | undefined;
    if (hasLocalCoords && neighbor.latitude && neighbor.longitude &&
        (neighbor.latitude !== 0 || neighbor.longitude !== 0)) {
      distanceToLocal = calculateDistance(
        localLat!, localLon!,
        neighbor.latitude, neighbor.longitude
      );
    }
    
    const candidate: DisambiguationCandidate = {
      hash,
      prefix,
      positionCounts: new Array(MAX_POSITIONS).fill(0),
      totalAppearances: 0,
      typicalPosition: 0,
      positionConsistency: 0,
      adjacentPrefixCounts: new Map(),
      totalAdjacentObservations: 0,
      latitude: neighbor.latitude,
      longitude: neighbor.longitude,
      distanceToLocal,
      positionScore: 0,
      cooccurrenceScore: 0,
      geographicScore: 0,
      combinedScore: 0,
    };
    
    const existing = prefixToCandidates.get(prefix) || [];
    existing.push(candidate);
    prefixToCandidates.set(prefix, existing);
  }
  
  // ─── Step 2: Analyze packets for position and co-occurrence data ─────────────
  for (const packet of packets) {
    const path = parsePath(packet);
    if (!path) continue;
    
    // Process each element in the path
    for (let i = 0; i < path.length; i++) {
      const prefix = path[i];
      const candidates = prefixToCandidates.get(prefix);
      if (!candidates) continue;
      
      // Position: 1 = last element (direct forwarder), 2 = second-to-last, etc.
      const position = path.length - i;
      const positionIndex = Math.min(position - 1, MAX_POSITIONS - 1);
      
      // Update position counts for all candidates matching this prefix
      for (const candidate of candidates) {
        candidate.positionCounts[positionIndex]++;
        candidate.totalAppearances++;
        
        // Track adjacent prefixes (before and after in path)
        if (i > 0) {
          const prevPrefix = path[i - 1];
          candidate.adjacentPrefixCounts.set(
            prevPrefix,
            (candidate.adjacentPrefixCounts.get(prevPrefix) || 0) + 1
          );
          candidate.totalAdjacentObservations++;
        }
        if (i < path.length - 1) {
          const nextPrefix = path[i + 1];
          candidate.adjacentPrefixCounts.set(
            nextPrefix,
            (candidate.adjacentPrefixCounts.get(nextPrefix) || 0) + 1
          );
          candidate.totalAdjacentObservations++;
        }
      }
    }
  }
  
  // ─── Step 3: Calculate scores for each candidate ─────────────────────────────
  // First, find max values for normalization
  let maxAppearances = 1;
  let maxAdjacentObs = 1;
  
  for (const candidates of prefixToCandidates.values()) {
    for (const c of candidates) {
      maxAppearances = Math.max(maxAppearances, c.totalAppearances);
      maxAdjacentObs = Math.max(maxAdjacentObs, c.totalAdjacentObservations);
    }
  }
  
  // Calculate scores for each candidate
  for (const candidates of prefixToCandidates.values()) {
    for (const candidate of candidates) {
      // Position score: consistency + frequency
      if (candidate.totalAppearances > 0) {
        // Find typical position (mode)
        let maxCount = 0;
        let typicalPos = 1;
        for (let i = 0; i < MAX_POSITIONS; i++) {
          if (candidate.positionCounts[i] > maxCount) {
            maxCount = candidate.positionCounts[i];
            typicalPos = i + 1;
          }
        }
        candidate.typicalPosition = typicalPos;
        candidate.positionConsistency = maxCount / candidate.totalAppearances;
        
        // Position score = consistency * frequency (normalized)
        const frequencyScore = candidate.totalAppearances / maxAppearances;
        candidate.positionScore = candidate.positionConsistency * 0.6 + frequencyScore * 0.4;
      }
      
      // Co-occurrence score: based on total adjacent observations
      if (candidate.totalAdjacentObservations > 0) {
        candidate.cooccurrenceScore = candidate.totalAdjacentObservations / maxAdjacentObs;
      }
      
      // Geographic score: inverse of distance to local
      if (candidate.distanceToLocal !== undefined) {
        // Score = 1 / (1 + distance/expectedMax), capped at 1
        candidate.geographicScore = Math.min(1, 1 / (1 + candidate.distanceToLocal / EXPECTED_MAX_HOP_DISTANCE));
      } else if (candidate.latitude && candidate.longitude) {
        // Has coords but no local coords - neutral score
        candidate.geographicScore = 0.5;
      } else {
        // No coords - low score
        candidate.geographicScore = 0.2;
      }
      
      // Combined score
      candidate.combinedScore = 
        candidate.positionScore * SCORE_WEIGHTS.position +
        candidate.cooccurrenceScore * SCORE_WEIGHTS.cooccurrence +
        candidate.geographicScore * SCORE_WEIGHTS.geographic;
    }
  }
  
  // ─── Step 4: Build disambiguation results ────────────────────────────────────
  for (const [prefix, candidates] of prefixToCandidates) {
    // Sort by combined score descending
    candidates.sort((a, b) => b.combinedScore - a.combinedScore);
    
    const bestMatch = candidates.length > 0 ? candidates[0].hash : null;
    
    // Calculate confidence based on score separation
    let confidence = 0;
    if (candidates.length === 1) {
      confidence = 1; // Only one candidate = 100% confident
    } else if (candidates.length > 1) {
      const best = candidates[0].combinedScore;
      const second = candidates[1].combinedScore;
      // Confidence = how much better is best vs second
      // If best = 0.8, second = 0.2, confidence = 0.6 / 0.8 = 0.75
      // If best = 0.8, second = 0.75, confidence = 0.05 / 0.8 = 0.0625
      if (best > 0) {
        confidence = Math.min(1, (best - second) / best);
      }
      // Boost confidence if best has significantly more appearances
      if (candidates[0].totalAppearances > candidates[1].totalAppearances * 2) {
        confidence = Math.min(1, confidence + 0.2);
      }
    }
    
    // Build position-specific best matches
    const bestMatchForPosition = new Map<number, { hash: string; confidence: number }>();
    for (let pos = 1; pos <= MAX_POSITIONS; pos++) {
      // Sort candidates by their count at this position
      const sortedByPosition = [...candidates].sort((a, b) => {
        const aCount = a.positionCounts[pos - 1] || 0;
        const bCount = b.positionCounts[pos - 1] || 0;
        return bCount - aCount;
      });
      
      if (sortedByPosition.length > 0 && sortedByPosition[0].positionCounts[pos - 1] > 0) {
        const bestForPos = sortedByPosition[0];
        let posConfidence = 1;
        if (sortedByPosition.length > 1) {
          const bestCount = bestForPos.positionCounts[pos - 1];
          const secondCount = sortedByPosition[1].positionCounts[pos - 1] || 0;
          const total = bestCount + secondCount;
          posConfidence = total > 0 ? bestCount / total : 0;
        }
        bestMatchForPosition.set(pos, { hash: bestForPos.hash, confidence: posConfidence });
      }
    }
    
    const result: DisambiguationResult = {
      prefix,
      candidates,
      bestMatch,
      confidence,
      isUnambiguous: candidates.length === 1,
      bestMatchForPosition,
    };
    
    lookup.set(prefix, result);
  }
  
  return lookup;
}

/**
 * Resolve a prefix to a hash using the lookup table.
 * 
 * @param lookup - The prefix lookup table
 * @param prefix - The 2-char prefix to resolve
 * @param context - Optional context for position-aware resolution
 * @returns { hash, confidence } or { hash: null, confidence: 0 } if not found
 */
export function resolvePrefix(
  lookup: PrefixLookup,
  prefix: string,
  context?: ResolutionContext
): { hash: string | null; confidence: number } {
  const normalized = prefix.toUpperCase();
  const result = lookup.get(normalized);
  
  if (!result || result.candidates.length === 0) {
    return { hash: null, confidence: 0 };
  }
  
  // If position context provided and we have position-specific data, use it
  if (context?.position && result.bestMatchForPosition.has(context.position)) {
    const posMatch = result.bestMatchForPosition.get(context.position)!;
    // Blend position-specific confidence with global confidence
    const blendedConfidence = (posMatch.confidence + result.confidence) / 2;
    return { hash: posMatch.hash, confidence: blendedConfidence };
  }
  
  // If adjacent prefixes provided, boost candidates with high co-occurrence
  if (context?.adjacentPrefixes && context.adjacentPrefixes.length > 0) {
    let bestHash = result.bestMatch;
    let bestScore = 0;
    
    for (const candidate of result.candidates) {
      let coScore = 0;
      for (const adjPrefix of context.adjacentPrefixes) {
        coScore += candidate.adjacentPrefixCounts.get(adjPrefix.toUpperCase()) || 0;
      }
      // Combine co-occurrence with global score
      const totalScore = candidate.combinedScore + (coScore / Math.max(1, candidate.totalAdjacentObservations)) * 0.3;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestHash = candidate.hash;
      }
    }
    
    return { hash: bestHash, confidence: result.confidence };
  }
  
  // Default: return global best match
  return { hash: result.bestMatch, confidence: result.confidence };
}

/**
 * Get all candidates for a prefix (for UI display of ambiguity).
 */
export function getCandidates(
  lookup: PrefixLookup,
  prefix: string
): DisambiguationCandidate[] {
  const normalized = prefix.toUpperCase();
  const result = lookup.get(normalized);
  return result?.candidates || [];
}

/**
 * Check if a prefix has collisions (multiple candidates).
 */
export function hasCollision(lookup: PrefixLookup, prefix: string): boolean {
  const normalized = prefix.toUpperCase();
  const result = lookup.get(normalized);
  return result ? result.candidates.length > 1 : false;
}

/**
 * Get disambiguation statistics for debugging.
 */
export function getDisambiguationStats(lookup: PrefixLookup): {
  totalPrefixes: number;
  unambiguousPrefixes: number;
  collisionPrefixes: number;
  avgConfidence: number;
  lowConfidencePrefixes: string[];
} {
  let totalConfidence = 0;
  let collisionCount = 0;
  const lowConfidence: string[] = [];
  
  for (const [prefix, result] of lookup) {
    totalConfidence += result.confidence;
    if (!result.isUnambiguous) {
      collisionCount++;
      if (result.confidence < 0.5) {
        lowConfidence.push(prefix);
      }
    }
  }
  
  return {
    totalPrefixes: lookup.size,
    unambiguousPrefixes: lookup.size - collisionCount,
    collisionPrefixes: collisionCount,
    avgConfidence: lookup.size > 0 ? totalConfidence / lookup.size : 0,
    lowConfidencePrefixes: lowConfidence,
  };
}
