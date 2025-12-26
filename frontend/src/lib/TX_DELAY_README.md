# MeshCore TX Delay System

This document explains the TX delay recommendation system used in pymc_console, which aligns with MeshCore's firmware-level slot-based transmission timing.

## Overview

MeshCore uses a **slot-based random backoff** system to prevent packet collisions. The key insight is that the delay value is **quantized** into integer slots, meaning small changes (< 0.2 seconds) have **no effect**.

## The MeshCore Formula

```
t(txdelay) = trunc(Af × 5 × txdelay)
```

| Variable | Description | Default |
|----------|-------------|---------|
| `Af` | Airtime factor | 1.0 |
| `txdelay` | Delay in seconds | 0.7 (flood), 0.199 (direct) |
| `t()` | Slot count (integer) | — |

### Stair-Step Behavior

Due to `trunc()` (integer truncation), the output is a **stair-step function**:

```
txdelay (sec)  │  slots
───────────────┼─────────
     0.0       │    0
     0.2       │    1     ← boundary
     0.4       │    2     ← boundary
     0.5       │    2     ← NO CHANGE (same as 0.4)
     0.6       │    3     ← boundary
     0.7       │    3     ← NO CHANGE (same as 0.6)
     0.8       │    4     ← boundary
     1.0       │    5     ← boundary
```

**Key insight**: Values like 0.65, 0.70, and 0.79 all produce **3 slots**. Only crossing a 0.2s boundary changes behavior.

## File Structure

```
src/lib/
├── meshcore-tx-constants.ts    # Constants, utilities, types
├── mesh-topology.ts            # Topology-wide TX recommendations
└── TX_DELAY_README.md          # This file

src/components/
└── stats/
    └── TxDelayCard.tsx         # Local node recommendations UI
```

## Constants (`meshcore-tx-constants.ts`)

### Firmware Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SLOT_MULTIPLIER` | 5 | Multiplier in slot formula |
| `RESOLUTION_SECONDS` | 0.2 | Minimum meaningful change |
| `DEFAULT_FLOOD_DELAY_SEC` | 0.7 | MeshCore default for flood |
| `DEFAULT_DIRECT_DELAY_SEC` | 0.199 | MeshCore default for direct |
| `DIRECT_TO_FLOOD_RATIO` | 0.28 | Direct ≈ 28% of flood |
| `MIN_TX_DELAY_SEC` | 0.0 | Minimum valid delay |
| `MAX_TX_DELAY_SEC` | 3.0 | Maximum valid delay |
| `MAX_SLOTS` | 15 | Maximum slot count |

### Network Role Thresholds

| Constant | Value | Description |
|----------|-------|-------------|
| `HUB_NEIGHBOR_THRESHOLD` | 4 | Neighbors to be a "hub" |
| `MIN_PACKETS_FOR_TX_DELAY` | 100 | Minimum packets for any recommendation |
| `MIN_PACKETS_FOR_CONFIDENT_TOPOLOGY` | 10000 | Minimum for confident recommendations |
| `LOW_SYMMETRY_THRESHOLD` | 0.3 | Below this, observer bias is likely high |
| `HIGH_SYMMETRY_THRESHOLD` | 0.5 | Above this, bidirectional traffic is well-observed |

## Utility Functions

### `calculateSlots(delaySec, airtimeFactor?)`

Calculate integer slot count from delay value.

```typescript
calculateSlots(0.8)   // → 4
calculateSlots(0.7)   // → 3
calculateSlots(0.75)  // → 3 (same as 0.7!)
```

### `alignToSlotBoundary(delaySec)`

Round delay to nearest 0.2s boundary.

```typescript
alignToSlotBoundary(0.73)  // → 0.8 (rounds up)
alignToSlotBoundary(0.65)  // → 0.6 (rounds down)
alignToSlotBoundary(0.85)  // → 0.8 (rounds down)
```

### `formatTxDelay(delaySec)`

Format delay for display with slot count.

```typescript
formatTxDelay(0.8)  // → "0.8s (4 slots)"
formatTxDelay(1.0)  // → "1.0s (5 slots)"
```

### `classifyNetworkRole(neighborCount, betweenness, floodParticipation)`

Classify a node's role for delay strategy.

```typescript
classifyNetworkRole(6, 0.1, 0.3)  // → 'hub' (many neighbors)
classifyNetworkRole(2, 0.5, 0.8)  // → 'backbone' (high betweenness)
classifyNetworkRole(2, 0.1, 0.8)  // → 'relay' (high flood rate)
classifyNetworkRole(2, 0.1, 0.3)  // → 'edge' (low everything)
```

### `getBaseDelayForRole(role)`

Get starting delay for a network role.

| Role | Base Delay | Slots | Rationale |
|------|------------|-------|-----------|
| `edge` | 0.4s | 2 | Low traffic, can be aggressive |
| `backbone` | 0.6s | 3 | Critical path, balanced |
| `relay` | 0.7s | 3 | MeshCore default |
| `hub` | 0.8s | 4 | Many neighbors, conservative |

## Mesh-Wide Optimization

### Why Individual Optimization Fails

If every node optimizes its own txdelay independently, they may all converge to the same value—causing **collision cascades** when multiple nodes transmit simultaneously.

### Slot Staggering

The topology engine distributes nodes across **adjacent slots** when multiple would otherwise use the same delay:

```typescript
// If nodes A, B, C all calculate 0.8s (4 slots):
// - Node A (highest traffic): stays at 0.8s (4 slots)
// - Node B: shifted to 1.0s (5 slots)
// - Node C: shifted to 1.2s (6 slots)
```

This is implemented in `calculateNodeTxDelays()` (Phase 3).

### Observer Bias Correction

**Problem**: Path position is observer-centric. A node at "position 1" from our view might be "position 3" from another node's perspective. Using position for recommendations creates inconsistent advice across the mesh.

**Solution**: We use only **observer-independent metrics**:

| Metric | Why It's Observer-Independent |
|--------|-------------------------------|
| `directNeighborCount` | Topological - count of edges, not position |
| `avgSymmetryRatio` | Bidirectional traffic indicator |
| `relativeTraffic` | Normalized across mesh |

**Symmetry as Confidence**: Edge symmetry (forward/reverse traffic ratio) indicates whether we're seeing the "whole picture" or just traffic flowing toward us:

| Symmetry | Interpretation | Confidence |
|----------|---------------|------------|
| ≥ 0.5 | Bidirectional traffic, low bias | High |
| 0.3-0.5 | Some bidirectional visibility | Medium |
| < 0.3 | Mostly unidirectional, high bias | Low |

High-symmetry nodes receive +0.2s delay bonus because we're confident in their centrality.

## Recommendation Types

### `TxDelayRecommendation` (mesh-topology.ts)

Full recommendation for a node in the network topology.

```typescript
interface TxDelayRecommendation {
  // MeshCore-aligned (primary)
  floodDelaySec: number;      // Aligned to 0.2s
  directDelaySec: number;     // Aligned to 0.2s
  floodSlots: number;         // Integer slot count
  directSlots: number;        // Integer slot count
  
  // Network analysis
  networkRole: 'edge' | 'relay' | 'hub' | 'backbone';
  rationale: string;          // Human-readable explanation
  adjustment: 'increase' | 'decrease' | 'stable';
  
  // Observer bias correction
  observationSymmetry: number;  // 0-1, higher = less bias
  dataConfidence: 'insufficient' | 'low' | 'medium' | 'high';
  
  // Legacy (backward compat)
  txDelayFactor: number;      // Alias for floodDelaySec
  directTxDelayFactor: number; // Alias for directDelaySec
  
  // ... additional metrics
}
```

### `MeshTxDelayRecommendation` (meshcore-tx-constants.ts)

Simplified recommendation for standalone use.

```typescript
interface MeshTxDelayRecommendation {
  floodDelaySec: number;
  directDelaySec: number;
  floodSlots: number;
  directSlots: number;
  role: NetworkRole;
  confidence: number;
  rationale: string;
  adjustment: 'increase' | 'decrease' | 'stable';
  currentDelaySec?: number;
}
```

## Integration Points

### 1. Local Node Card (`TxDelayCard.tsx`)

Recommends txdelay for **this node** based on:
- Duplicate rate (target: 5-8%)
- TX utilization
- Zero-hop neighbor count

### 2. Topology Map (`mesh-topology.ts`)

Recommends txdelay for **all nodes** based on:
- Network role (edge/relay/hub/backbone) - uses neighbor count + symmetry
- Collision risk (traffic × neighbors × path count)
- Edge symmetry (bidirectional traffic = +1 slot)
- Slot staggering (prevent same-slot clusters)

**Note**: Path position is NOT used for recommendations due to observer bias.

### 3. Node Popup (`node-popup.tsx`)

Displays recommendation with confidence indicators:
```
TX F 0.8s (4) D 0.2s (1) ✓     # High confidence (green check)
hub ↔65%                        # Symmetry indicator
```

Symmetry indicators:
- `↔` (65%+) = Good bidirectional visibility
- `⇄` (30-65%) = Moderate visibility  
- `→` (<30%) = Mostly unidirectional (⚠️ possible bias)

## Example: Complete Flow

```typescript
// 1. Topology engine collects metrics for node "0x19ABCD..."
const metrics = {
  neighborCount: 5,
  avgSymmetryRatio: 0.65,  // Good bidirectional visibility
  trafficIntensity: 12.5,
  pathCount: 42,
};

// 2. Classify role (observer-independent)
// Uses neighborCount + symmetry, NOT floodParticipation
if (neighborCount >= 4 && avgSymmetryRatio >= 0.5) → 'backbone'
else if (neighborCount >= 4) → 'hub'
else if (avgSymmetryRatio >= 0.3 && neighborCount >= 2) → 'relay'
else → 'edge'

// 3. Get base delay
let delay = getBaseDelayForRole('hub');  // → 0.8s

// 4. Apply collision risk adjustment
delay += collisionRisk * 0.4;  // → ~0.95s

// 5. Apply symmetry bonus (high symmetry = confident in centrality)
if (avgSymmetryRatio >= 0.6) delay += 0.2;  // → 1.15s

// 6. Align to slot boundary
const aligned = alignToSlotBoundary(1.15);  // → 1.2s

// 7. Calculate slots
const slots = calculateSlots(1.2);  // → 6

// 8. Check for staggering (if other nodes at same slot)
// ... may shift if collision detected

// 9. Create recommendation with confidence
const rec = {
  floodDelaySec: 1.2,
  directDelaySec: 0.4,  // 1.2 × 0.28, aligned
  floodSlots: 6,
  directSlots: 2,
  networkRole: 'hub',
  rationale: 'Hub: 5 neighbors, 65% symmetric. High bidirectional visibility (+1 slot)',
  adjustment: 'increase',
  observationSymmetry: 0.65,
  dataConfidence: 'high',  // Good packet count + good symmetry
};
```

## Common Pitfalls

### ❌ Using Raw Values

```typescript
// BAD: 0.75 and 0.79 produce identical results!
setTxDelay(0.75);
setTxDelay(0.79);  // No change
```

### ✅ Always Align

```typescript
// GOOD: Align to meaningful boundaries
const delay = alignToSlotBoundary(rawValue);
setTxDelay(delay);
```

### ❌ Ignoring Slot Count

```typescript
// BAD: Comparing raw values
if (newDelay > currentDelay) { /* ... */ }
```

### ✅ Compare Slots

```typescript
// GOOD: Compare what actually matters
const newSlots = calculateSlots(newDelay);
const currentSlots = calculateSlots(currentDelay);
if (newSlots > currentSlots) { /* ... */ }
```

## References

- [MeshCore Firmware](https://github.com/rightup/MeshCore) - Source of slot formula
- [meshcore-bot](https://github.com/agessaman/meshcore-bot) - Inspired path analysis
- `mesh-topology.ts` - Topology-based recommendations
- `TxDelayCard.tsx` - Local node recommendations
