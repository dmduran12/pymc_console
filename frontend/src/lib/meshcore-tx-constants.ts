/**
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║                    MESHCORE TX DELAY CONSTANTS & UTILITIES                    ║
 * ╠═══════════════════════════════════════════════════════════════════════════════╣
 * ║ Centralized module for MeshCore txdelay calculations and recommendations.    ║
 * ║ All txdelay logic should import from this file for consistency.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 *
 * ## MeshCore Firmware Formula
 *
 * ```
 * t(txdelay) = trunc(Af * 5 * txdelay)
 * ```
 *
 * Where:
 * - `Af` = Airtime Factor (default 1.0)
 * - `txdelay` = Configured delay in seconds (0.0 - 3.0)
 * - `t()` = Number of random backoff "slots" (integer)
 *
 * ## Key Insight: Stair-Step Quantization
 *
 * Due to `trunc()` (integer truncation), txdelay exhibits **stair-step** behavior:
 *
 * ```
 * txdelay │ slots
 * ────────┼───────
 *   0.0   │   0
 *   0.2   │   1    ← +0.2s = +1 slot
 *   0.4   │   2
 *   0.6   │   3
 *   0.7   │   3    ← Same as 0.6! No effect.
 *   0.8   │   4    ← Crosses boundary
 *   1.0   │   5
 * ```
 *
 * **Changes < 0.2 seconds have NO EFFECT.** This module ensures all
 * recommendations align to 0.2s boundaries for meaningful impact.
 *
 * ## MeshCore Defaults
 *
 * - `tx_delay_factor`: 0.7 seconds (3 slots) - for flood routing
 * - `direct.tx_delay_factor`: ~0.2 seconds (1 slot) - for direct routing
 * - Ratio: Direct is ~28% of flood delay
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   calculateSlots,
 *   alignToSlotBoundary,
 *   formatTxDelay,
 *   classifyNetworkRole,
 *   getBaseDelayForRole,
 * } from '@/lib/meshcore-tx-constants';
 *
 * // Calculate slots for a delay value
 * const slots = calculateSlots(0.8);  // → 4
 *
 * // Ensure delay is at a meaningful boundary
 * const aligned = alignToSlotBoundary(0.73);  // → 0.8 (rounds up)
 *
 * // Format for display
 * const display = formatTxDelay(0.8);  // → "0.8s (4 slots)"
 *
 * // Get recommended delay for a node role
 * const role = classifyNetworkRole(neighbors, betweenness, floodRate);
 * const baseDelay = getBaseDelayForRole(role);  // hub → 0.8s
 * ```
 *
 * ## File Organization
 *
 * 1. **Firmware Constants**: MeshCore protocol values
 * 2. **Network Role Thresholds**: Classification parameters
 * 3. **Mesh Optimization Targets**: Health metrics
 * 4. **Utility Functions**: Slot calculations, alignment, formatting
 * 5. **Mesh-Wide Helpers**: Role classification, staggering
 * 6. **Recommendation Interface**: Complete recommendation type
 *
 * @see https://github.com/rightup/MeshCore - MeshCore firmware source
 * @see mesh-topology.ts - Uses this for topology TX recommendations
 * @see TxDelayCard.tsx - Uses this for local node recommendations
 */

// ============================================================================
// MeshCore Firmware Constants
// ============================================================================

/** Airtime factor - multiplier in slot calculation (Af in formula) */
export const AIRTIME_FACTOR = 1.0;

/** Slot multiplier - produces 5 slots per 1.0 second of txdelay */
export const SLOT_MULTIPLIER = 5;

/** Minimum meaningful txdelay change in seconds (1 slot = 0.2s) */
export const RESOLUTION_SECONDS = 0.2;

/** Default flood txdelay in seconds (MeshCore default) */
export const DEFAULT_FLOOD_DELAY_SEC = 0.7;

/** Default direct txdelay in seconds (MeshCore default) */
export const DEFAULT_DIRECT_DELAY_SEC = 0.199;

/** MeshCore's direct-to-flood ratio (~28%) */
export const DIRECT_TO_FLOOD_RATIO = 0.28;

/** Minimum txdelay in seconds */
export const MIN_TX_DELAY_SEC = 0.0;

/** Maximum txdelay in seconds */
export const MAX_TX_DELAY_SEC = 3.0;

/** Maximum slots (at 3.0 seconds) */
export const MAX_SLOTS = 15;

// ============================================================================
// Network Role Thresholds
// ============================================================================

/**
 * Nodes with neighbor count >= this are considered "hub" nodes.
 * Hub nodes should use higher txdelay to reduce collision impact.
 */
export const HUB_NEIGHBOR_THRESHOLD = 4;

/**
 * Nodes with edge betweenness >= this are backbone nodes.
 * Backbone nodes carry significant traffic and need balanced delays.
 */
export const BACKBONE_BETWEENNESS_THRESHOLD = 0.3;

/**
 * Nodes with flood participation >= this are heavy forwarders.
 * High flood participation suggests the node sees lots of traffic.
 */
export const HIGH_FLOOD_PARTICIPATION_THRESHOLD = 0.7;

// ============================================================================
// Mesh Optimization Targets
// ============================================================================

/**
 * Target duplicate rate for healthy mesh (5-8%).
 * Below this suggests txdelay can be reduced.
 * Above this suggests txdelay should increase.
 */
export const TARGET_DUPLICATE_RATE_LOW = 0.05;
export const TARGET_DUPLICATE_RATE_HIGH = 0.08;

/**
 * Network-wide slot distribution targets.
 * Ideally, nodes should be spread across different slot counts
 * to reduce collision probability.
 */
export const SLOT_DISTRIBUTION_VARIANCE_TARGET = 2.0;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate the number of random backoff slots for a given txdelay.
 * Implements MeshCore formula: t(txdelay) = trunc(Af * 5 * txdelay)
 *
 * @param delaySec - TX delay in seconds
 * @param airtimeFactor - Airtime factor (default 1.0)
 * @returns Integer slot count
 */
export function calculateSlots(
  delaySec: number,
  airtimeFactor: number = AIRTIME_FACTOR
): number {
  return Math.floor(airtimeFactor * SLOT_MULTIPLIER * delaySec);
}

/**
 * Align a txdelay value to the nearest 0.2-second boundary.
 * Values between boundaries have no effect in MeshCore, so we round
 * to the nearest meaningful value.
 *
 * @param delaySec - TX delay in seconds
 * @returns Aligned delay in seconds (multiple of 0.2)
 */
export function alignToSlotBoundary(delaySec: number): number {
  const aligned = Math.round(delaySec / RESOLUTION_SECONDS) * RESOLUTION_SECONDS;
  return Math.max(MIN_TX_DELAY_SEC, Math.min(MAX_TX_DELAY_SEC, aligned));
}

/**
 * Convert a slot count back to txdelay in seconds.
 *
 * @param slots - Number of slots
 * @returns TX delay in seconds
 */
export function slotsToDelay(slots: number): number {
  return slots / SLOT_MULTIPLIER;
}

/**
 * Calculate direct txdelay from flood txdelay using MeshCore's ratio.
 *
 * @param floodDelaySec - Flood TX delay in seconds
 * @returns Direct TX delay in seconds, aligned to slot boundary
 */
export function calculateDirectDelay(floodDelaySec: number): number {
  const directRaw = floodDelaySec * DIRECT_TO_FLOOD_RATIO;
  return alignToSlotBoundary(directRaw);
}

/**
 * Validate that a txdelay value is within MeshCore's valid range.
 *
 * @param delaySec - TX delay in seconds
 * @returns True if valid
 */
export function isValidTxDelay(delaySec: number): boolean {
  return delaySec >= MIN_TX_DELAY_SEC && delaySec <= MAX_TX_DELAY_SEC;
}

/**
 * Format txdelay for display with slot count.
 *
 * @param delaySec - TX delay in seconds
 * @returns Formatted string like "0.8s (4 slots)"
 */
export function formatTxDelay(delaySec: number): string {
  const slots = calculateSlots(delaySec);
  return `${delaySec.toFixed(1)}s (${slots} slot${slots !== 1 ? 's' : ''})`;
}

/**
 * Determine recommended txdelay adjustment direction.
 *
 * @param currentSlots - Current slot count
 * @param targetSlots - Target slot count
 * @returns 'increase' | 'decrease' | 'stable'
 */
export function getAdjustmentDirection(
  currentSlots: number,
  targetSlots: number
): 'increase' | 'decrease' | 'stable' {
  if (targetSlots > currentSlots) return 'increase';
  if (targetSlots < currentSlots) return 'decrease';
  return 'stable';
}

// ============================================================================
// Mesh-Wide Optimization Helpers
// ============================================================================

/**
 * Network role classification for a node.
 * Used to determine appropriate txdelay strategy.
 */
export type NetworkRole = 'edge' | 'relay' | 'hub' | 'backbone';

/**
 * Classify a node's role in the network based on topology metrics.
 *
 * @param neighborCount - Number of direct neighbors
 * @param betweenness - Edge betweenness centrality (0-1)
 * @param floodParticipation - Flood participation rate (0-1)
 * @returns Network role classification
 */
export function classifyNetworkRole(
  neighborCount: number,
  betweenness: number,
  floodParticipation: number
): NetworkRole {
  // High betweenness = backbone (critical traffic path)
  if (betweenness >= BACKBONE_BETWEENNESS_THRESHOLD) {
    return 'backbone';
  }

  // Many neighbors = hub (local aggregation point)
  if (neighborCount >= HUB_NEIGHBOR_THRESHOLD) {
    return 'hub';
  }

  // High flood participation but not a hub = relay
  if (floodParticipation >= HIGH_FLOOD_PARTICIPATION_THRESHOLD) {
    return 'relay';
  }

  // Low connectivity and low traffic = edge node
  return 'edge';
}

/**
 * Get base txdelay recommendation for a network role.
 * These are starting points that get adjusted by mesh-wide factors.
 *
 * @param role - Network role
 * @returns Base txdelay in seconds
 */
export function getBaseDelayForRole(role: NetworkRole): number {
  switch (role) {
    case 'backbone':
      // Backbone nodes: moderate delay, balanced for throughput
      return 0.6;
    case 'hub':
      // Hub nodes: higher delay to reduce collision cascade
      return 0.8;
    case 'relay':
      // Relay nodes: slightly above default
      return 0.7;
    case 'edge':
      // Edge nodes: can be more aggressive
      return 0.5;
  }
}

/**
 * Calculate slot stagger offset for mesh-wide diversity.
 * When multiple nodes would have the same slot count, we stagger
 * them to reduce collision probability.
 *
 * @param nodeIndex - Node's index in sorted list
 * @param totalNodesAtSlot - Total nodes at this slot count
 * @returns Offset in seconds (0, 0.2, or 0.4)
 */
export function calculateStaggerOffset(
  nodeIndex: number,
  totalNodesAtSlot: number
): number {
  if (totalNodesAtSlot <= 1) return 0;

  // Distribute across up to 3 sub-slots (0, 0.2, 0.4)
  const subSlot = nodeIndex % 3;
  return subSlot * RESOLUTION_SECONDS;
}

/**
 * Recommendation with full context for mesh optimization.
 */
export interface MeshTxDelayRecommendation {
  /** Flood TX delay in seconds, aligned to 0.2s */
  floodDelaySec: number;
  /** Direct TX delay in seconds, aligned to 0.2s */
  directDelaySec: number;
  /** Flood slot count (integer) */
  floodSlots: number;
  /** Direct slot count (integer) */
  directSlots: number;
  /** Network role classification */
  role: NetworkRole;
  /** Confidence in recommendation (0-1) */
  confidence: number;
  /** Human-readable rationale */
  rationale: string;
  /** Suggested adjustment from current */
  adjustment: 'increase' | 'decrease' | 'stable';
  /** Current delay if known (for comparison) */
  currentDelaySec?: number;
}

/**
 * Create a complete recommendation object.
 *
 * @param floodDelaySec - Flood delay (will be aligned)
 * @param role - Network role
 * @param confidence - Confidence level
 * @param rationale - Explanation
 * @param currentDelaySec - Current delay for comparison
 * @returns Complete recommendation
 */
export function createRecommendation(
  floodDelaySec: number,
  role: NetworkRole,
  confidence: number,
  rationale: string,
  currentDelaySec?: number
): MeshTxDelayRecommendation {
  const alignedFlood = alignToSlotBoundary(floodDelaySec);
  const alignedDirect = calculateDirectDelay(alignedFlood);

  const currentSlots = currentDelaySec !== undefined
    ? calculateSlots(currentDelaySec)
    : undefined;
  const targetSlots = calculateSlots(alignedFlood);

  return {
    floodDelaySec: alignedFlood,
    directDelaySec: alignedDirect,
    floodSlots: targetSlots,
    directSlots: calculateSlots(alignedDirect),
    role,
    confidence,
    rationale,
    adjustment: currentSlots !== undefined
      ? getAdjustmentDirection(currentSlots, targetSlots)
      : 'stable',
    currentDelaySec,
  };
}
