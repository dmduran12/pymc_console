/**
 * Prefix Disambiguation System
 * 
 * Resolves 2-character hex prefix collisions in MeshCore packet paths.
 * With 180+ neighbors and only 256 possible prefixes, collisions are inevitable.
 * 
 * This module provides a centralized disambiguation service using four weighted factors:
 * 
 * 1. Path Position Consistency (15%) - Where does this node typically appear in paths?
 *    Shared across all candidates matching the same prefix.
 * 
 * 2. Co-occurrence Frequency (15%) - How often does this prefix appear alongside others?
 *    Shared across all candidates matching the same prefix.
 * 
 * 3. Geographic Scoring (40%) - Distance-based scoring with dual-hop anchor correlation.
 *    Candidate-specific evidence from:
 *    - Distance to local node (closer = higher score)
 *    - Source-geographic correlation (position-1 proximity to packet source)
 *    - Previous-hop anchor (proximity to resolved upstream node)
 *    - Next-hop anchor (proximity to resolved downstream node)
 *    - Zero-hop boost for known direct RF contacts
 * 
 * 4. Recency Scoring (30%) - When was this node last seen? (meshcore-bot inspired)
 *    Uses exponential decay: score = e^(-hours/12)
 *    Nodes not seen in 14 days are filtered out entirely.
 * 
 * Additional confidence boosts:
 * - Dominant forwarder boost: 80%+ of position-1 appearances → +0.3 to +0.6
 * - Score-weighted redistribution: Reallocates shared counts by combined score
 * - Source-geographic evidence boost: 50%+ more geo evidence → up to +0.3
 * 
 * Usage:
 *   const lookup = buildPrefixLookup(packets, neighbors, localHash, localLat, localLon);
 *   const { hash, confidence } = resolvePrefix(lookup, "24");
 */

import type { Packet, NeighborInfo } from '@/types/api';
import { parsePacketPath, getHashPrefix as getPrefix, getPositionFromIndex } from '@/lib/path-utils';
import { calculateDistance, PROXIMITY_BANDS } from '@/lib/geo-utils';

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
  
  // ─── Source-Geographic Evidence ──────────────────────────────────────────────
  /** Evidence score from source-geographic correlation at position 1 */
  srcGeoEvidenceScore: number;
  /** Number of position-1 observations with geographic evidence */
  srcGeoEvidenceCount: number;
  
  // ─── Recency Scoring (inspired by meshcore-bot) ──────────────────────────────
  /** Unix timestamp when this node was last seen (from neighbor.last_seen) */
  lastSeenTimestamp: number;
  /** 0-1: Recency score using exponential decay e^(-hours/12) */
  recencyScore: number;
  
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

/** 
 * Weights for combining scores.
 * Geographic + Recency weighted highest as they provide candidate-specific evidence.
 * Position/co-occurrence data is shared among all candidates matching the same prefix.
 */
const SCORE_WEIGHTS = {
  position: 0.15,      // Shared across collision candidates
  cooccurrence: 0.15,  // Shared across collision candidates
  geographic: 0.40,    // Candidate-specific - distance to local
  recency: 0.30,       // Candidate-specific - when last seen
};

/** Maximum hop positions to track */
const MAX_POSITIONS = 5;

/**
 * Maximum age for candidates to be considered (in hours).
 * Nodes not seen in this period are filtered out before disambiguation.
 * Default: 336 hours = 14 days (matches meshcore-bot's max_repeater_age_days)
 */
const MAX_CANDIDATE_AGE_HOURS = 336;

/**
 * Recency decay half-life in hours.
 * Score = e^(-hours/RECENCY_DECAY_HOURS)
 * At 12 hours: ~37% score, at 24 hours: ~14%, at 48 hours: ~2%
 */
const RECENCY_DECAY_HOURS = 12;

// Geographic scoring uses PROXIMITY_BANDS from geo-utils.ts
// See: PROXIMITY_BANDS.VERY_CLOSE (500m), CLOSE (2km), MEDIUM (5km), FAR (10km), VERY_FAR (20km)

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

// Re-export from path-utils for backward compatibility
export { getHashPrefix, prefixMatches } from '@/lib/path-utils';

// calculateDistance is now imported from geo-utils.ts

/**
 * Calculate recency score using exponential decay.
 * Inspired by meshcore-bot: score = e^(-hours/12)
 * 
 * @param lastSeenTimestamp - Unix timestamp (seconds) when node was last seen
 * @param nowTimestamp - Current timestamp (defaults to now)
 * @returns 0-1 score where 1.0 = just seen, decaying over time
 */
function calculateRecencyScore(lastSeenTimestamp: number, nowTimestamp?: number): number {
  if (!lastSeenTimestamp || lastSeenTimestamp <= 0) {
    return 0.1; // Unknown recency gets low score
  }
  
  const now = nowTimestamp ?? Math.floor(Date.now() / 1000);
  const hoursAgo = (now - lastSeenTimestamp) / 3600;
  
  if (hoursAgo < 0) {
    return 1.0; // Future timestamp (clock skew) - assume recent
  }
  
  // Exponential decay: e^(-hours/12)
  // 1 hour ago: ~0.92
  // 6 hours ago: ~0.61
  // 12 hours ago: ~0.37
  // 24 hours ago: ~0.14
  // 48 hours ago: ~0.02
  return Math.exp(-hoursAgo / RECENCY_DECAY_HOURS);
}

/**
 * Check if a candidate is too old to be considered.
 * @param lastSeenTimestamp - Unix timestamp when node was last seen
 * @returns true if candidate should be filtered out
 */
function isCandidateTooOld(lastSeenTimestamp: number): boolean {
  if (!lastSeenTimestamp || lastSeenTimestamp <= 0) {
    return false; // Unknown age - don't filter (could be local node)
  }
  
  const now = Math.floor(Date.now() / 1000);
  const hoursAgo = (now - lastSeenTimestamp) / 3600;
  
  return hoursAgo > MAX_CANDIDATE_AGE_HOURS;
}

// Path parsing now handled by path-utils.ts

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
    const localPrefix = getPrefix(localHash);
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
      srcGeoEvidenceScore: 0,
      srcGeoEvidenceCount: 0,
      lastSeenTimestamp: Math.floor(Date.now() / 1000), // Local is always "just seen"
      recencyScore: 1.0, // Local gets max recency
      positionScore: 0,
      cooccurrenceScore: 0,
      geographicScore: 1.0, // Local is always at distance 0
      combinedScore: 0,
    };
    prefixToCandidates.set(localPrefix, [candidate]);
  }
  
  // Add all neighbors (with age filtering)
  for (const [hash, neighbor] of Object.entries(neighbors)) {
    const prefix = getPrefix(hash);
    const lastSeenTimestamp = neighbor.last_seen ?? 0;
    
    // Skip candidates that are too old (not seen in MAX_CANDIDATE_AGE_HOURS)
    if (isCandidateTooOld(lastSeenTimestamp)) {
      continue;
    }
    
    let distanceToLocal: number | undefined;
    const isZeroHop = neighbor.zero_hop === true; // Direct radio contact flag
    
    if (hasLocalCoords && neighbor.latitude && neighbor.longitude &&
        (neighbor.latitude !== 0 || neighbor.longitude !== 0)) {
      distanceToLocal = calculateDistance(
        localLat!, localLon!,
        neighbor.latitude, neighbor.longitude
      );
    }
    
    // Calculate initial geographic score based on distance
    let geoScore = 0.2; // Default for unknown location
    if (distanceToLocal !== undefined) {
      // Distance-based scoring with steep falloff for close neighbors
      if (distanceToLocal < PROXIMITY_BANDS.VERY_CLOSE) {
        geoScore = 1.0;
      } else if (distanceToLocal < PROXIMITY_BANDS.CLOSE) {
        geoScore = 0.8;
      } else if (distanceToLocal < PROXIMITY_BANDS.MEDIUM) {
        geoScore = 0.6;
      } else if (distanceToLocal < PROXIMITY_BANDS.FAR) {
        geoScore = 0.4;
      } else if (distanceToLocal < PROXIMITY_BANDS.VERY_FAR) {
        geoScore = 0.2;
      } else {
        geoScore = 0.1;
      }
    } else if (neighbor.latitude && neighbor.longitude) {
      // Has coords but no local coords - neutral score
      geoScore = 0.5;
    }
    
    // MAJOR BOOST: If this neighbor has zero_hop flag (known direct contact)
    // This is the strongest signal - we've actually received RF from them
    if (isZeroHop) {
      geoScore = Math.max(geoScore, 0.95);
    }
    
    // Calculate recency score using exponential decay
    const recencyScore = calculateRecencyScore(lastSeenTimestamp);
    
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
      srcGeoEvidenceScore: 0,
      srcGeoEvidenceCount: 0,
      lastSeenTimestamp,
      recencyScore,
      positionScore: 0,
      cooccurrenceScore: 0,
      geographicScore: geoScore, // Pre-calculated
      combinedScore: 0,
    };
    
    const existing = prefixToCandidates.get(prefix) || [];
    existing.push(candidate);
    prefixToCandidates.set(prefix, existing);
  }
  
  // ─── Step 2: Analyze packets for position and co-occurrence data ─────────────
  // Use centralized path parsing from path-utils.ts
  // 
  // NEW: Source-Geographic Correlation
  // When a prefix appears at position 1 (last hop to local), we can use the packet's
  // src_hash to determine which candidate is geographically plausible. If the source
  // node is close to candidate A but far from candidate B, that's strong evidence
  // that A is the actual forwarder.
  
  for (const packet of packets) {
    const parsed = parsePacketPath(packet, localHash);
    if (!parsed || parsed.effectiveLength === 0) continue;
    
    const path = parsed.effective; // Local already stripped
    
    // Get source node info for geographic correlation
    const srcHash = packet.src_hash;
    const srcNeighbor = srcHash ? neighbors[srcHash] : undefined;
    const srcHasCoords = srcNeighbor?.latitude && srcNeighbor?.longitude &&
      (srcNeighbor.latitude !== 0 || srcNeighbor.longitude !== 0);
    
    // Process each element in the effective path
    for (let i = 0; i < path.length; i++) {
      const prefix = path[i];
      const candidates = prefixToCandidates.get(prefix);
      if (!candidates) continue;
      
      // Position: 1 = last element (direct forwarder), 2 = second-to-last, etc.
      const position = getPositionFromIndex(i, parsed.effectiveLength);
      const positionIndex = Math.min(position - 1, MAX_POSITIONS - 1);
      
      // Update position counts for all candidates matching this prefix
      for (const candidate of candidates) {
        candidate.positionCounts[positionIndex]++;
        candidate.totalAppearances++;
        
        // === SOURCE-GEOGRAPHIC CORRELATION ===
        // For position 1 (last hop) with multiple candidates, use source location
        // to score which candidate is geographically plausible as the forwarder.
        //
        // Logic: The last hop must be within RF range of BOTH:
        //   1. The source (or previous hop in chain)
        //   2. The local node
        // A candidate that is close to local AND on a reasonable path from source
        // is more likely to be the actual forwarder.
        if (position === 1 && candidates.length > 1 && srcHasCoords && 
            candidate.latitude && candidate.longitude) {
          // Calculate distance from source to this candidate
          const distToSrc = calculateDistance(
            srcNeighbor!.latitude!, srcNeighbor!.longitude!,
            candidate.latitude, candidate.longitude
          );
          
          // Score based on source proximity (closer = more likely forwarder)
          // A gateway node receiving from the mesh should be within reasonable range
          // of nodes it forwards packets from.
          let evidence = 0;
          if (distToSrc < 500) {
            evidence = 1.0;   // Very close to source - strong evidence
          } else if (distToSrc < 2000) {
            evidence = 0.8;   // Within 2km - good evidence
          } else if (distToSrc < 5000) {
            evidence = 0.5;   // Within 5km - moderate evidence
          } else if (distToSrc < 10000) {
            evidence = 0.3;   // Within 10km - weak evidence
          } else {
            evidence = 0.1;   // Far from source - unlikely but possible via multi-hop
          }
          
          // Also factor in distance to local (closer to local = better gateway candidate)
          if (candidate.distanceToLocal !== undefined) {
            if (candidate.distanceToLocal < 500) {
              evidence *= 1.2;  // Close to local - boost
            } else if (candidate.distanceToLocal < 2000) {
              evidence *= 1.0;  // Reasonable
            } else {
              evidence *= 0.8;  // Far from local - less likely to be our gateway
            }
          }
          
          candidate.srcGeoEvidenceScore += evidence;
          candidate.srcGeoEvidenceCount++;
        }
        
        // === PREVIOUS-HOP ANCHOR CORRELATION (meshcore-bot inspired) ===
        // For positions not at the start of path, use the PREVIOUS hop's location
        // as an anchor. A relay node should be within RF range of the node that
        // forwarded to it. This complements the next-hop anchor below.
        if (i > 0 && candidates.length > 1 && candidate.latitude && candidate.longitude) {
          const prevHopIndex = i - 1;
          const prevHopPrefix = path[prevHopIndex];
          const prevHopCandidates = prefixToCandidates.get(prevHopPrefix);
          
          if (prevHopCandidates && prevHopCandidates.length > 0) {
            // Find the best previous-hop candidate location
            let anchorLat: number | undefined;
            let anchorLon: number | undefined;
            let anchorConfidence = 0;
            
            if (prevHopCandidates.length === 1) {
              const anchor = prevHopCandidates[0];
              if (anchor.latitude && anchor.longitude) {
                anchorLat = anchor.latitude;
                anchorLon = anchor.longitude;
                anchorConfidence = 1.0;
              }
            } else {
              // Use best-scoring candidate with coords
              const sorted = [...prevHopCandidates].sort((a, b) => b.combinedScore - a.combinedScore);
              const best = sorted[0];
              const second = sorted[1];
              if (best.latitude && best.longitude && best.combinedScore > 0) {
                const scoreSeparation = second ? (best.combinedScore - second.combinedScore) / best.combinedScore : 1;
                anchorConfidence = Math.min(1, scoreSeparation + 0.3);
                if (anchorConfidence > 0.4) {
                  anchorLat = best.latitude;
                  anchorLon = best.longitude;
                }
              }
            }
            
            if (anchorLat !== undefined && anchorLon !== undefined) {
              const distToAnchor = calculateDistance(
                candidate.latitude, candidate.longitude,
                anchorLat, anchorLon
              );
              
              // Score by proximity to previous-hop anchor
              let evidence = 0;
              if (distToAnchor < 500) {
                evidence = 1.0;
              } else if (distToAnchor < 2000) {
                evidence = 0.8;
              } else if (distToAnchor < 5000) {
                evidence = 0.5;
              } else if (distToAnchor < 10000) {
                evidence = 0.3;
              } else {
                evidence = 0.1;
              }
              
              evidence *= anchorConfidence;
              candidate.srcGeoEvidenceScore += evidence;
              candidate.srcGeoEvidenceCount++;
            }
          }
        }
        
        // === NEXT-HOP ANCHOR CORRELATION ===
        // For position 2+ (not last hop), if the NEXT hop in the path is unambiguous
        // or has a known location, use that to score this candidate.
        // This enables "recursive disambiguation" - once we know node 24 is the gateway,
        // we can use its location to disambiguate nodes that forward TO it.
        if (position > 1 && candidates.length > 1 && candidate.latitude && candidate.longitude) {
          // Get the next hop prefix (the node this candidate forwarded to)
          const nextHopIndex = i + 1;
          if (nextHopIndex < path.length) {
            const nextHopPrefix = path[nextHopIndex];
            const nextHopCandidates = prefixToCandidates.get(nextHopPrefix);
            
            // Check if next hop is unambiguous or has a dominant candidate with coords
            if (nextHopCandidates && nextHopCandidates.length > 0) {
              // Find the best next-hop candidate (by existing scores or unambiguous)
              let anchorLat: number | undefined;
              let anchorLon: number | undefined;
              let anchorConfidence = 0;
              
              if (nextHopCandidates.length === 1) {
                // Unambiguous - use it as anchor
                const anchor = nextHopCandidates[0];
                if (anchor.latitude && anchor.longitude) {
                  anchorLat = anchor.latitude;
                  anchorLon = anchor.longitude;
                  anchorConfidence = 1.0;
                }
              } else {
                // Multiple candidates - use the one with highest combinedScore if it has coords
                // This creates a "soft" anchor based on current best guess
                const sorted = [...nextHopCandidates].sort((a, b) => b.combinedScore - a.combinedScore);
                const best = sorted[0];
                const second = sorted[1];
                if (best.latitude && best.longitude && best.combinedScore > 0) {
                  // Confidence in anchor = score separation
                  const scoreSeparation = second ? (best.combinedScore - second.combinedScore) / best.combinedScore : 1;
                  anchorConfidence = Math.min(1, scoreSeparation + 0.3); // Boost a bit since we're iterating
                  if (anchorConfidence > 0.4) { // Only use if reasonably confident
                    anchorLat = best.latitude;
                    anchorLon = best.longitude;
                  }
                }
              }
              
              // If we have an anchor, score this candidate by proximity to it
              if (anchorLat !== undefined && anchorLon !== undefined) {
                const distToAnchor = calculateDistance(
                  candidate.latitude, candidate.longitude,
                  anchorLat, anchorLon
                );
                
                // Score by proximity to next-hop anchor
                // Nodes that forward to the anchor should be within RF range
                let evidence = 0;
                if (distToAnchor < 500) {
                  evidence = 1.0;   // Very close - strong evidence
                } else if (distToAnchor < 2000) {
                  evidence = 0.8;   // Within 2km
                } else if (distToAnchor < 5000) {
                  evidence = 0.5;   // Within 5km
                } else if (distToAnchor < 10000) {
                  evidence = 0.3;   // Within 10km
                } else {
                  evidence = 0.1;   // Far
                }
                
                // Weight by anchor confidence
                evidence *= anchorConfidence;
                
                // Add to srcGeoEvidence (reusing the same accumulator)
                candidate.srcGeoEvidenceScore += evidence;
                candidate.srcGeoEvidenceCount++;
              }
            }
          }
        }
        
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
      
      // Geographic score is pre-calculated during candidate creation
      // (includes distance-based scoring and zero_hop boost)
      // Recency score is pre-calculated using exponential decay
      
      // Combined score (4-factor calculation)
      candidate.combinedScore = 
        candidate.positionScore * SCORE_WEIGHTS.position +
        candidate.cooccurrenceScore * SCORE_WEIGHTS.cooccurrence +
        candidate.geographicScore * SCORE_WEIGHTS.geographic +
        candidate.recencyScore * SCORE_WEIGHTS.recency;
      
      // === SOURCE-GEOGRAPHIC EVIDENCE BOOST ===
      // If this candidate has accumulated evidence from src_hash correlation,
      // boost its combined score. This is CANDIDATE-SPECIFIC evidence (unlike
      // position counts which are shared across all candidates for a prefix).
      if (candidate.srcGeoEvidenceCount > 0) {
        const avgEvidence = candidate.srcGeoEvidenceScore / candidate.srcGeoEvidenceCount;
        // Weight by observation count (more observations = more reliable)
        // Cap at 50 observations to prevent runaway scores
        const observationWeight = Math.min(candidate.srcGeoEvidenceCount / 50, 1);
        // Boost is up to 0.3 (30% of max score) based on evidence strength and count
        const srcGeoBoost = avgEvidence * observationWeight * 0.3;
        candidate.combinedScore += srcGeoBoost;
      }
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
      
      // ═══ DOMINANT FORWARDER BOOST ═══════════════════════════════════════════
      // If one candidate is overwhelmingly the last hop (position 1) to local,
      // that's extremely strong evidence it's our direct neighbor/gateway.
      // This handles the case where an observer node receives almost all traffic
      // through a single rooftop repeater.
      //
      // Criteria (all must be met for boost):
      // - At least 20 total observations at position 1 across colliding candidates
      // - Best candidate has 80%+ of position-1 appearances
      // - Best candidate has at least 10 position-1 appearances (absolute minimum)
      //
      // NOTE: No confidence floor - position dominance alone is strong evidence
      const pos1Index = 0; // Position 1 = last hop = index 0
      const bestPos1Count = candidates[0].positionCounts[pos1Index] || 0;
      const secondPos1Count = candidates[1].positionCounts[pos1Index] || 0;
      const totalPos1 = bestPos1Count + secondPos1Count;
      
      if (totalPos1 >= 20 && bestPos1Count >= 10) {
        const pos1Ratio = bestPos1Count / totalPos1;
        if (pos1Ratio >= 0.80) {
          // This candidate is dominant at position 1 - major confidence boost
          // Scale boost by how dominant (80% = +0.3, 90% = +0.45, 100% = +0.6)
          const dominanceBoost = 0.30 + (pos1Ratio - 0.80) * 1.5; // 0.30 to 0.60
          const newConfidence = Math.min(1, confidence + dominanceBoost);
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`[disambiguation] Prefix ${prefix}: DOMINANT BOOST! ratio=${pos1Ratio.toFixed(2)}, boost=${dominanceBoost.toFixed(2)}, newConf=${newConfidence.toFixed(2)}`);
          }
          
          confidence = newConfidence;
        }
      }
      
      // ═══ SCORE-WEIGHTED APPEARANCE REDISTRIBUTION ════════════════════════════
      // The raw position/co-occurrence counts are shared across all candidates
      // because we can't know which candidate was actually present when we see
      // prefix "24" in a path. But now that we have combined scores, we can
      // REDISTRIBUTE the appearances proportionally by score.
      //
      // This gives us candidate-specific appearance estimates that we can use
      // for the dominant forwarder boost.
      const totalScore = candidates.reduce((sum, c) => sum + c.combinedScore, 0);
      if (totalScore > 0) {
        // Calculate weighted position-1 counts
        const weightedPos1Counts: number[] = [];
        const rawPos1Total = candidates.reduce((sum, c) => sum + (c.positionCounts[0] || 0), 0);
        
        for (const c of candidates) {
          const weight = c.combinedScore / totalScore;
          // This candidate's share of position-1 appearances
          const weightedPos1 = rawPos1Total * weight;
          weightedPos1Counts.push(weightedPos1);
        }
        
        // Now check dominant forwarder with WEIGHTED counts
        const bestWeightedPos1 = weightedPos1Counts[0];
        const secondWeightedPos1 = weightedPos1Counts[1] || 0;
        const weightedTotal = bestWeightedPos1 + secondWeightedPos1;
        
        if (weightedTotal >= 20 && bestWeightedPos1 >= 10) {
          const weightedRatio = bestWeightedPos1 / weightedTotal;
          if (weightedRatio >= 0.60) { // Lowered from 0.80 since weighted counts are estimates
            // Weighted dominant forwarder boost
            // Scale: 60% = +0.2, 80% = +0.4, 100% = +0.6
            const dominanceBoost = 0.20 + (weightedRatio - 0.60) * 1.0;
            const newConfidence = Math.min(1, confidence + dominanceBoost);
            
            confidence = newConfidence;
          }
        }
      }
      
      // ═══ SOURCE-GEOGRAPHIC EVIDENCE BOOST ═══════════════════════════════════════
      // If the best candidate has significantly more source-geographic evidence
      // than the runner-up, that's strong candidate-specific evidence.
      // This differentiates candidates that otherwise have identical position stats.
      const bestSrcGeoEvidence = candidates[0].srcGeoEvidenceScore;
      const secondSrcGeoEvidence = candidates[1].srcGeoEvidenceScore;
      const bestSrcGeoCount = candidates[0].srcGeoEvidenceCount;
      
      if (bestSrcGeoCount >= 10 && bestSrcGeoEvidence > secondSrcGeoEvidence * 1.5) {
        // Best candidate has 50%+ more geographic evidence - boost confidence
        const evidenceRatio = secondSrcGeoEvidence > 0 
          ? bestSrcGeoEvidence / (bestSrcGeoEvidence + secondSrcGeoEvidence)
          : 1.0;
        const srcGeoConfBoost = Math.min(0.3, (evidenceRatio - 0.5) * 0.6); // Up to +0.3
        const newConfidence = Math.min(1, confidence + srcGeoConfBoost);
        
        if (process.env.NODE_ENV === 'development' && srcGeoConfBoost > 0.05) {
          console.log(`[disambiguation] Prefix ${prefix}: SRC-GEO BOOST! bestEvidence=${bestSrcGeoEvidence.toFixed(1)}, secondEvidence=${secondSrcGeoEvidence.toFixed(1)}, boost=${srcGeoConfBoost.toFixed(2)}, newConf=${newConfidence.toFixed(2)}`);
        }
        
        confidence = newConfidence;
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
  
  // For last hop (direct forwarder to local), use the global confidence which
  // includes the dominant forwarder boost. This is the most important case.
  if (context?.isLastHop) {
    return { hash: result.bestMatch, confidence: result.confidence };
  }
  
  // For position 1 (also last hop), prefer global confidence with boost
  if (context?.position === 1) {
    return { hash: result.bestMatch, confidence: result.confidence };
  }
  
  // If position context provided and we have position-specific data, use it
  // But take the MAX of position confidence and global confidence to preserve boosts
  if (context?.position && result.bestMatchForPosition.has(context.position)) {
    const posMatch = result.bestMatchForPosition.get(context.position)!;
    // Use max instead of average to preserve boosted global confidence
    const bestConfidence = Math.max(posMatch.confidence, result.confidence);
    return { hash: posMatch.hash, confidence: bestConfidence };
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
  
  // Default: return global best match with full (potentially boosted) confidence
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
