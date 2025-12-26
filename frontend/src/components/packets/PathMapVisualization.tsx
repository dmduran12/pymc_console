import { useMemo, useState, Suspense, lazy, Component, ReactNode } from 'react';
import { NeighborInfo } from '@/types/api';
import { MapPin, AlertTriangle, HelpCircle } from 'lucide-react';
import clsx from 'clsx';
import { matchPrefix, prefixMatches, NeighborAffinity } from '@/lib/mesh-topology';
import { resolvePrefix, type PrefixLookup } from '@/lib/prefix-disambiguation';
import { getHashPrefix } from '@/lib/path-utils';

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
 * Get proximity score (0-1) based on distance to local node.
 */
function getProximityScore(distanceMeters: number): number {
  if (distanceMeters < 100) return 1.0;
  if (distanceMeters < 500) return 0.9;
  if (distanceMeters < 1000) return 0.7;
  if (distanceMeters < 5000) return 0.5;
  if (distanceMeters < 10000) return 0.3;
  return 0.1;
}

// Lazy load MapLibre map component (replacing Leaflet)
const PathMap = lazy(() => import('./PathMapMapLibre'));

export interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface PathMapVisualizationProps {
  /** Path prefixes from packet (original_path or forwarded_path) - relay hops only */
  path: string[];
  /** All known neighbors with location data */
  neighbors: Record<string, NeighborInfo>;
  /** Local node info */
  localNode?: LocalNode;
  /** Local node's hash (for matching if we're in the path) */
  localHash?: string;
  /** Packet source hash - shown as first node in path (100% confidence) */
  srcHash?: string;
  /** Packet destination hash - shown as last node in path (100% confidence) */
  dstHash?: string;
  /** Pre-computed affinity data for multi-factor scoring */
  neighborAffinity?: Map<string, NeighborAffinity>;
  /** Pre-computed prefix disambiguation lookup (preferred for confidence) */
  prefixLookup?: PrefixLookup;
  /** Hub node hashes for visual distinction on map */
  hubNodes?: string[];
}

/** Candidate node for a path prefix with display info */
export interface PathCandidate {
  hash: string;
  name: string;
  latitude: number;
  longitude: number;
  probability: number;  // 1/k where k is number of candidates
  isLocal?: boolean;
  isDirectNeighbor?: boolean;  // True if zero_hop neighbor (direct radio contact)
}

/** Resolved hop in the path */
export interface ResolvedHop {
  prefix: string;
  candidates: PathCandidate[];
  confidence: number;  // Max probability among candidates (0 if none)
  totalMatches: number;  // Total prefix matches (including those without coordinates)
  isSource?: boolean;  // True if this is the packet source
  isDestination?: boolean;  // True if this is the packet destination
}

/** Result of path resolution */
export interface ResolvedPath {
  hops: ResolvedHop[];
  overallConfidence: number;  // Product of per-hop confidences
  hasValidPath: boolean;  // At least one hop has candidates
}

/**
 * Match a prefix to nodes with display coordinates.
 * Uses shared matchPrefix from mesh-topology, then enriches with location data.
 * 
 * @param prefix - The 2-char hex prefix to match
 * @param neighbors - Known neighbors
 * @param localNode - Local node info (for coordinates)
 * @param localHash - Local node's full hash
 * @param isLastHop - If true, this is the receiving node (us)
 */
/** Extended result including total match count for confidence display */
interface PrefixMatchResult {
  candidates: PathCandidate[];
  /** Total number of prefix matches (including those without coordinates) */
  totalMatches: number;
}

function matchPrefixToNodes(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localNode?: LocalNode,
  localHash?: string,
  isLastHop: boolean = false,
  neighborAffinity?: Map<string, NeighborAffinity>,
  prefixLookup?: PrefixLookup,
  position?: number
): PrefixMatchResult {
  // If we have a prefix lookup, use it for confidence (includes dominant forwarder boost)
  let lookupConfidence: number | undefined;
  if (prefixLookup) {
    const lookupResult = resolvePrefix(prefixLookup, prefix, {
      position,
      isLastHop,
    });
    lookupConfidence = lookupResult.confidence;
  }
  
  // Use shared matching logic from mesh-topology (pass affinity for tiebreaking)
  const { matches, probability } = matchPrefix(prefix, neighbors, localHash, neighborAffinity, isLastHop);
  
  // Store total matches BEFORE filtering by coordinates
  const totalMatches = matches.length;
  
  const candidates: PathCandidate[] = [];
  const normalizedPrefix = prefix.toUpperCase();
  
  // Check if local node has valid coordinates
  const localHasCoords = localNode && 
    localNode.latitude !== undefined && 
    localNode.longitude !== undefined &&
    (localNode.latitude !== 0 || localNode.longitude !== 0);
  
  // Build candidates with coordinates from matches
  for (const hash of matches) {
    // Check if this is the local node
    if (localHash && prefixMatches(normalizedPrefix, localHash)) {
      if (hash === localHash && localHasCoords && localNode) {
        candidates.push({
          hash,
          name: localNode.name || 'Local Node',
          latitude: localNode.latitude,
          longitude: localNode.longitude,
          probability: isLastHop ? 1 : probability,
          isLocal: true,
        });
        continue;
      }
    }
    
    // Check neighbors for coordinates
    const neighbor = neighbors[hash];
    if (neighbor?.latitude && neighbor?.longitude && 
        !(neighbor.latitude === 0 && neighbor.longitude === 0)) {
      candidates.push({
        hash,
        name: neighbor.node_name || neighbor.name || 'Unknown',
        latitude: neighbor.latitude,
        longitude: neighbor.longitude,
        probability,
        isLocal: false,
        isDirectNeighbor: neighbor.zero_hop === true,
      });
    }
  }
  
  // Recalculate probabilities using multi-factor scoring
  const k = candidates.length;
  
  if (k === 1) {
    // Single candidate with coords - high confidence
    // Use lookup confidence if available (includes dominant forwarder boost)
    candidates[0].probability = lookupConfidence ?? 1;
  } else if (k > 1) {
    // If we have a lookup confidence from disambiguation, use it for the best candidate
    // This includes the dominant forwarder boost!
    if (lookupConfidence !== undefined && lookupConfidence > 0) {
      // Assign lookup confidence to best candidate, distribute remaining to others
      const bestCandidate = candidates[0]; // First candidate is usually best match
      bestCandidate.probability = lookupConfidence;
      
      // Distribute remaining probability among other candidates
      const remaining = 1 - lookupConfidence;
      const otherCount = k - 1;
      candidates.slice(1).forEach(c => {
        c.probability = remaining / otherCount;
      });
    } else {
      // Fallback: Multiple candidates - use multi-factor scoring
      let totalScore = 0;
      const scores = candidates.map(c => {
        if (c.isLocal) return { candidate: c, score: 1.0 }; // Local always highest
        
        // Get affinity data if available
        const aff = neighborAffinity?.get(c.hash);
        
        // Calculate Haversine-based proximity score
        let haversineScore = 0.5; // Default
        if (localHasCoords && localNode) {
          const dist = calculateDistance(
            localNode.latitude, localNode.longitude,
            c.latitude, c.longitude
          );
          haversineScore = getProximityScore(dist);
        }
        
        // Multi-factor score combining:
        // - Haversine proximity (30%)
        // - Hop consistency from affinity (30%)
        // - Frequency from affinity (40%)
        let score: number;
        if (aff) {
          score = 
            haversineScore * 0.3 +
            aff.hopConsistencyScore * 0.3 +
            aff.frequencyScore * 0.4;
        } else {
          // Fallback to just Haversine if no affinity data
          score = haversineScore;
          // Boost direct neighbors
          if (c.isDirectNeighbor) {
            score = Math.max(score, 0.8);
          }
        }
        
        totalScore += score;
        return { candidate: c, score };
      });
      
      // Assign probabilities based on multi-factor scores (normalized)
      if (totalScore > 0) {
        scores.forEach(({ candidate, score }) => {
          // Cap at 0.95 to indicate some uncertainty with multiple matches
          candidate.probability = Math.min(0.95, score / totalScore);
        });
      } else {
        const prob = 1 / k;
        candidates.forEach(c => c.probability = prob);
      }
    }
  }
  
  return { candidates, totalMatches };
}

/**
 * Resolve a full path to candidate nodes with confidence scores.
 * Uses prefix disambiguation lookup when available (preferred - includes dominant forwarder boost).
 * Falls back to multi-factor scoring when affinity data is available:
 * - Haversine distance (30%)
 * - Hop consistency (30%)
 * - Frequency (40%)
 */
export function resolvePath(
  path: string[],
  neighbors: Record<string, NeighborInfo>,
  localNode?: LocalNode,
  localHash?: string,
  neighborAffinity?: Map<string, NeighborAffinity>,
  prefixLookup?: PrefixLookup
): ResolvedPath {
  if (!path || path.length === 0) {
    return { hops: [], overallConfidence: 0, hasValidPath: false };
  }
  
  const lastIndex = path.length - 1;
  
  const hops: ResolvedHop[] = path.map((prefix, index) => {
    const isLastHop = index === lastIndex;
    // Position is 1-indexed from the END (last hop = position 1)
    const position = path.length - index;
    const { candidates, totalMatches } = matchPrefixToNodes(
      prefix, neighbors, localNode, localHash, isLastHop, neighborAffinity, prefixLookup, position
    );
    const confidence = candidates.length > 0 ? Math.max(...candidates.map(c => c.probability)) : 0;
    return { prefix, candidates, confidence, totalMatches };
  });
  
  // Overall confidence: product of individual confidences
  // If any hop has 0 confidence, overall is 0
  const overallConfidence = hops.reduce((acc, hop) => {
    if (hop.confidence === 0) return 0;
    return acc * hop.confidence;
  }, 1);
  
  const hasValidPath = hops.some(hop => hop.candidates.length > 0);
  
  return { hops, overallConfidence, hasValidPath };
}

/**
 * Format confidence as percentage string
 */
function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

/**
 * Get color based on confidence level for text
 */
function getConfidenceColor(confidence: number): string {
  if (confidence >= 1) return 'text-accent-success';      // 100% - green
  if (confidence >= 0.5) return 'text-accent-secondary';  // 50-99% - yellow
  if (confidence >= 0.25) return 'text-signal-poor';      // 25-49% - orange (uses theme var)
  if (confidence > 0) return 'text-accent-danger';        // 1-24% - red
  return 'text-text-muted';                               // 0% - gray
}

/**
 * Get inline style color for hop badge based on confidence.
 * Uses inline styles to guarantee color application regardless of CSS specificity.
 */
function getHopBadgeStyle(confidence: number, candidateCount: number): React.CSSProperties {
  // Color values from the design system
  const colors = {
    success: '#39D98A',    // Green - 100% confidence
    secondary: '#F9D26F',  // Yellow - 50-99%
    poor: '#FF8A5C',       // Orange - 25-49%
    danger: '#FF5C7A',     // Red - 1-24%
    muted: '#767688',      // Gray - unknown/0%
  };
  
  let color: string;
  if (candidateCount === 0) {
    color = colors.muted;     // Unknown - gray
  } else if (confidence >= 1) {
    color = colors.success;   // 100% - green
  } else if (confidence >= 0.5) {
    color = colors.secondary; // 50-99% - yellow  
  } else if (confidence >= 0.25) {
    color = colors.poor;      // 25-49% - orange
  } else if (confidence > 0) {
    color = colors.danger;    // 1-24% - red
  } else {
    color = colors.muted;     // fallback - gray
  }
  
  return { color };
}

// Error boundary for map loading
class MapErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-[200px] flex items-center justify-center text-text-muted">
          <AlertTriangle className="w-4 h-4 mr-2" />
          Map failed to load
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Path Map Visualization component
 * Shows complete packet path: Source → [relay hops] → Destination
 * Interactive hover highlighting and confidence scoring
 */
export function PathMapVisualization({
  path,
  neighbors,
  localNode,
  localHash,
  srcHash,
  dstHash,
  neighborAffinity,
  prefixLookup,
  hubNodes,
}: PathMapVisualizationProps) {
  // Hover state for highlighting - shared between badges and map
  const [hoveredHopIndex, setHoveredHopIndex] = useState<number | null>(null);
  
  // Build source hop from srcHash (100% confidence - we know exactly who sent it)
  const sourceHop = useMemo((): ResolvedHop | null => {
    if (!srcHash) return null;
    
    const srcPrefix = getHashPrefix(srcHash);
    const neighbor = neighbors[srcHash];
    
    // Check if we have location data for the source
    const hasLocation = neighbor?.latitude && neighbor?.longitude && 
        !(neighbor.latitude === 0 && neighbor.longitude === 0);
    
    if (hasLocation) {
      // Source with location - full candidate
      return {
        prefix: srcPrefix,
        candidates: [{
          hash: srcHash,
          name: neighbor.node_name || neighbor.name || 'Source',
          latitude: neighbor.latitude!,
          longitude: neighbor.longitude!,
          probability: 1, // 100% - exact match
          isLocal: false,
          isDirectNeighbor: neighbor.zero_hop === true,
        }],
        confidence: 1,
        totalMatches: 1,
        isSource: true, // Mark as source hop
      };
    }
    
    // Source without location - still show in path badges with name if available
    // Include a "virtual" candidate with name only (no coordinates) for tooltip display
    const sourceName = neighbor?.node_name || neighbor?.name || srcHash.slice(0, 8);
    return {
      prefix: srcPrefix,
      candidates: [{
        hash: srcHash,
        name: sourceName,
        latitude: 0, // No location
        longitude: 0,
        probability: 1,
        isLocal: false,
      }], // Virtual candidate for name display only
      confidence: 1, // We still know exactly who it is
      totalMatches: 1, // We matched the source
      isSource: true,
    };
  }, [srcHash, neighbors]);
  
  // Build destination hop from dstHash (100% confidence - we know exactly who it's for)
  const destinationHop = useMemo((): ResolvedHop | null => {
    if (!dstHash) return null;
    
    const dstPrefix = getHashPrefix(dstHash);
    
    // Check if destination is local node
    if (localHash && dstHash === localHash && localNode) {
      const hasLocation = localNode.latitude !== 0 || localNode.longitude !== 0;
      return {
        prefix: dstPrefix,
        candidates: [{
          hash: dstHash,
          name: localNode.name || 'Local Node',
          latitude: hasLocation ? localNode.latitude : 0,
          longitude: hasLocation ? localNode.longitude : 0,
          probability: 1,
          isLocal: true,
        }],
        confidence: 1,
        totalMatches: 1,
        isDestination: true,
      };
    }
    
    const neighbor = neighbors[dstHash];
    const hasLocation = neighbor?.latitude && neighbor?.longitude && 
        !(neighbor.latitude === 0 && neighbor.longitude === 0);
    
    if (hasLocation) {
      return {
        prefix: dstPrefix,
        candidates: [{
          hash: dstHash,
          name: neighbor.node_name || neighbor.name || 'Destination',
          latitude: neighbor.latitude!,
          longitude: neighbor.longitude!,
          probability: 1,
          isLocal: false,
          isDirectNeighbor: neighbor.zero_hop === true,
        }],
        confidence: 1,
        totalMatches: 1,
        isDestination: true,
      };
    }
    
    // Destination without location - still show in badges
    const dstName = neighbor?.node_name || neighbor?.name || dstHash.slice(0, 8);
    return {
      prefix: dstPrefix,
      candidates: [{
        hash: dstHash,
        name: dstName,
        latitude: 0,
        longitude: 0,
        probability: 1,
        isLocal: false,
      }],
      confidence: 1,
      totalMatches: 1,
      isDestination: true,
    };
  }, [dstHash, neighbors, localNode, localHash]);
  
  // Resolve path prefixes to candidate nodes
  const resolvedPathHops = useMemo(
    () => resolvePath(path, neighbors, localNode, localHash, neighborAffinity, prefixLookup),
    [path, neighbors, localNode, localHash, neighborAffinity, prefixLookup]
  );
  
  // Combine: Source → [relay hops] → Destination
  const resolvedPath = useMemo((): ResolvedPath => {
    const hops: ResolvedHop[] = [];
    
    // Add source at beginning
    if (sourceHop) {
      hops.push(sourceHop);
    }
    
    // Add relay hops from path
    hops.push(...resolvedPathHops.hops);
    
    // Add destination at end
    if (destinationHop) {
      hops.push(destinationHop);
    }
    
    // Recalculate overall confidence
    const overallConfidence = hops.reduce((acc, hop) => {
      if (hop.confidence === 0) return 0;
      return acc * hop.confidence;
    }, 1);
    
    // hasValidPath: at least one hop has candidates with real coordinates (not 0,0)
    const hasValidPath = hops.some(hop => 
      hop.candidates.some(c => 
        c.latitude !== 0 || c.longitude !== 0
      )
    );
    
    return {
      hops,
      overallConfidence,
      hasValidPath,
    };
  }, [sourceHop, resolvedPathHops, destinationHop]);
  
  // Don't render if no path or no candidates have coordinates
  if (!resolvedPath.hasValidPath) {
    return (
      <div className="flex items-center justify-center text-text-muted text-xs py-4">
        <MapPin className="w-3.5 h-3.5 mr-1.5 opacity-50" />
        No location data available for path nodes
      </div>
    );
  }
  
  return (
    <div className="space-y-2">
      {/* Confidence indicator */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted">Path Confidence:</span>
          <span className={getConfidenceColor(resolvedPath.overallConfidence)}>
            {formatConfidence(resolvedPath.overallConfidence)}
          </span>
          <button
            className="text-text-muted hover:text-text-secondary transition-colors"
            title="Confidence is calculated based on how many known nodes match each path prefix. Multiple matches reduce confidence due to collision probability."
          >
            <HelpCircle className="w-3 h-3" />
          </button>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-accent-success" />
            <span className="text-text-muted">Exact</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-accent-secondary" />
            <span className="text-text-muted">Multi</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-text-muted" />
            <span className="text-text-muted">Unknown</span>
          </div>
        </div>
      </div>
      
      {/* Map */}
      <div className="rounded-lg overflow-hidden border border-border-subtle">
        <MapErrorBoundary>
          <Suspense
            fallback={
              <div className="h-[200px] bg-bg-elevated flex items-center justify-center text-text-muted text-sm">
                Loading map...
              </div>
            }
          >
            <PathMap
              resolvedPath={resolvedPath}
              localNode={localNode}
              hubNodes={hubNodes}
              hoveredHopIndex={hoveredHopIndex}
              onHoverHop={setHoveredHopIndex}
            />
          </Suspense>
        </MapErrorBoundary>
      </div>
      
      {/* Per-hop breakdown - interactive: SRC → [hops] → DST */}
      <div className="flex flex-wrap items-center gap-1.5">
        {resolvedPath.hops.map((hop, i) => {
          const isSource = hop.isSource === true;
          const isDestination = hop.isDestination === true;
          const isHovered = hoveredHopIndex === i;
          
          // Build tooltip
          let title: string;
          if (isSource) {
            title = `Source: ${hop.candidates[0]?.name || 'Unknown'}`;
          } else if (isDestination) {
            title = `Destination: ${hop.candidates[0]?.name || 'Unknown'}`;
          } else if (hop.totalMatches === 0) {
            title = 'No matching nodes found';
          } else if (hop.totalMatches === 1) {
            title = `Exact match: ${hop.candidates[0]?.name || 'Unknown'}`;
          } else {
            title = `${hop.totalMatches} possible matches (${(hop.confidence * 100).toFixed(0)}% confidence)`;
          }
          
          return (
            <div
              key={i}
              className={clsx(
                'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-all',
                isHovered 
                  ? 'bg-accent-primary/20 ring-1 ring-accent-primary/50' 
                  : 'bg-bg-elevated hover:bg-bg-subtle',
                isSource && 'border border-accent-success/30',
                isDestination && 'border border-accent-primary/30'
              )}
              title={title}
              onMouseEnter={() => setHoveredHopIndex(i)}
              onMouseLeave={() => setHoveredHopIndex(null)}
            >
              {isSource && (
                <span className="text-accent-success text-[8px] mr-0.5">SRC</span>
              )}
              {isDestination && (
                <span className="text-accent-primary text-[8px] mr-0.5">DST</span>
              )}
              <span style={getHopBadgeStyle(hop.confidence, hop.totalMatches)}>
                {hop.prefix}
              </span>
              {!isSource && !isDestination && hop.totalMatches > 1 && (
                <span className="text-text-muted">×{hop.totalMatches}</span>
              )}
              {!isSource && !isDestination && hop.totalMatches === 0 && (
                <span className="text-text-muted">?</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
