import { useMemo, Suspense, lazy, Component, ReactNode } from 'react';
import { NeighborInfo } from '@/types/api';
import { MapPin, AlertTriangle, HelpCircle } from 'lucide-react';
import { getHashPrefix } from '@/lib/mesh-topology';

// Lazy load Leaflet map component
const PathMap = lazy(() => import('./PathMap'));

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface PathMapVisualizationProps {
  /** Path prefixes from packet (original_path or forwarded_path) */
  path: string[];
  /** All known neighbors with location data */
  neighbors: Record<string, NeighborInfo>;
  /** Local node info */
  localNode?: LocalNode;
  /** Local node's hash (for matching if we're in the path) */
  localHash?: string;
}

/** Candidate node for a path prefix */
export interface PathCandidate {
  hash: string;
  name: string;
  latitude: number;
  longitude: number;
  probability: number;  // 1/k where k is number of candidates
  isLocal?: boolean;
}

/** Resolved hop in the path */
export interface ResolvedHop {
  prefix: string;
  candidates: PathCandidate[];
  confidence: number;  // Max probability among candidates (0 if none)
}

/** Result of path resolution */
export interface ResolvedPath {
  hops: ResolvedHop[];
  overallConfidence: number;  // Product of per-hop confidences
  hasValidPath: boolean;  // At least one hop has candidates
}

/**
 * Match a 2-character prefix to known nodes.
 * Returns all nodes whose hash starts with this prefix.
 * 
 * @param prefix - The 2-char hex prefix to match
 * @param neighbors - Known neighbors
 * @param localNode - Local node info (for coordinates)
 * @param localHash - Local node's full hash
 * @param isLastHop - If true and prefix matches local, boost local's probability
 */
function matchPrefixToNodes(
  prefix: string,
  neighbors: Record<string, NeighborInfo>,
  localNode?: LocalNode,
  localHash?: string,
  isLastHop: boolean = false
): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  const normalizedPrefix = prefix.toUpperCase();
  const localPrefix = localHash ? getHashPrefix(localHash) : null;
  
  // Check if this prefix matches the local node
  const localMatches = localHash && localHash.toUpperCase().startsWith(normalizedPrefix) && localNode;
  
  // Check local node first
  if (localMatches) {
    candidates.push({
      hash: localHash,
      name: localNode.name || 'Local Node',
      latitude: localNode.latitude,
      longitude: localNode.longitude,
      probability: 0, // Will be calculated after
      isLocal: true,
    });
  }
  
  // Check all neighbors
  for (const [hash, neighbor] of Object.entries(neighbors)) {
    // Only include neighbors with valid coordinates
    if (!neighbor.latitude || !neighbor.longitude) continue;
    if (neighbor.latitude === 0 && neighbor.longitude === 0) continue;
    
    if (hash.toUpperCase().startsWith(normalizedPrefix)) {
      candidates.push({
        hash,
        name: neighbor.node_name || neighbor.name || 'Unknown',
        latitude: neighbor.latitude,
        longitude: neighbor.longitude,
        probability: 0, // Will be calculated after
        isLocal: false,
      });
    }
  }
  
  // Calculate probabilities
  const k = candidates.length;
  if (k > 0) {
    // If this is the last hop and local matches, give local 100% probability
    // (packets we receive end with our prefix)
    if (isLastHop && localMatches && localPrefix === normalizedPrefix) {
      candidates.forEach(c => {
        c.probability = c.isLocal ? 1 : 0;
      });
    } else {
      // Standard 1/k probability
      const prob = 1 / k;
      candidates.forEach(c => c.probability = prob);
    }
  }
  
  return candidates;
}

/**
 * Resolve a full path to candidate nodes with confidence scores.
 * Enhanced with local prefix detection - last hop matching local prefix gets 100% confidence.
 */
export function resolvePath(
  path: string[],
  neighbors: Record<string, NeighborInfo>,
  localNode?: LocalNode,
  localHash?: string
): ResolvedPath {
  if (!path || path.length === 0) {
    return { hops: [], overallConfidence: 0, hasValidPath: false };
  }
  
  const hops: ResolvedHop[] = path.map((prefix, index) => {
    const isLastHop = index === path.length - 1;
    const candidates = matchPrefixToNodes(prefix, neighbors, localNode, localHash, isLastHop);
    const confidence = candidates.length > 0 ? Math.max(...candidates.map(c => c.probability)) : 0;
    return { prefix, candidates, confidence };
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
 * Get color based on confidence level
 */
function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.9) return 'text-accent-success';
  if (confidence >= 0.5) return 'text-accent-secondary';
  if (confidence > 0) return 'text-accent-danger';
  return 'text-text-muted';
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
 * Shows packet path on a mini Leaflet map with prefix labels and confidence scoring
 */
export function PathMapVisualization({
  path,
  neighbors,
  localNode,
  localHash,
}: PathMapVisualizationProps) {
  // Resolve path prefixes to candidate nodes
  const resolvedPath = useMemo(
    () => resolvePath(path, neighbors, localNode, localHash),
    [path, neighbors, localNode, localHash]
  );
  
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
            />
          </Suspense>
        </MapErrorBoundary>
      </div>
      
      {/* Per-hop breakdown */}
      <div className="flex flex-wrap gap-1.5">
        {resolvedPath.hops.map((hop, i) => (
          <div
            key={i}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-elevated text-[10px] font-mono"
            title={
              hop.candidates.length === 0
                ? 'No matching nodes found'
                : hop.candidates.length === 1
                ? `Exact match: ${hop.candidates[0].name}`
                : `${hop.candidates.length} possible matches`
            }
          >
            <span
              className={
                hop.confidence >= 1
                  ? 'text-accent-success'
                  : hop.confidence > 0
                  ? 'text-accent-secondary'
                  : 'text-text-muted'
              }
            >
              {hop.prefix}
            </span>
            {hop.candidates.length > 1 && (
              <span className="text-text-muted">×{hop.candidates.length}</span>
            )}
            {hop.candidates.length === 0 && (
              <span className="text-text-muted">?</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
