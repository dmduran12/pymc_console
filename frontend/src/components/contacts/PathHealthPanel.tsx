/**
 * PathHealthPanel - Displays health indicators for top observed paths
 * 
 * Shows:
 * - Health score with color indicator
 * - Path hops as linked badges
 * - Weakest link identification
 * - Observation count and trend
 * - Click-to-highlight functionality
 */

import { useMemo, useState, memo } from 'react';
import { Activity, AlertTriangle, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, Zap, GitBranch } from 'lucide-react';
import { usePathHealth, type PathHealth } from '@/lib/stores/useTopologyStore';

interface PathHealthPanelProps {
  /** Maximum paths to display */
  maxPaths?: number;
  /** Callback when a path's weakest link edge is clicked */
  onHighlightEdge?: (edgeKey: string | null) => void;
  /** Currently highlighted edge key */
  highlightedEdge?: string | null;
}

/** Get health score color based on score (0-1) */
function getHealthColor(score: number): string {
  if (score >= 0.7) return 'text-accent-success';
  if (score >= 0.5) return 'text-accent-secondary';
  if (score >= 0.3) return 'text-signal-poor';
  return 'text-accent-danger';
}

/** Get health background color */
function getHealthBgColor(score: number): string {
  if (score >= 0.7) return 'bg-accent-success/10';
  if (score >= 0.5) return 'bg-accent-secondary/10';
  if (score >= 0.3) return 'bg-signal-poor/10';
  return 'bg-accent-danger/10';
}

/** Get trend icon and color */
function getTrendDisplay(trend: number): { icon: React.ReactNode; color: string } {
  if (trend > 0.2) return { icon: <TrendingUp className="w-3 h-3" />, color: 'text-accent-success' };
  if (trend < -0.2) return { icon: <TrendingDown className="w-3 h-3" />, color: 'text-accent-danger' };
  return { icon: <Minus className="w-3 h-3" />, color: 'text-text-muted' };
}

/** Format health score as percentage */
function formatHealthScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Single path row */
const PathRow = memo(function PathRow({
  path,
  isHighlighted,
  onHighlight,
}: {
  path: PathHealth;
  isHighlighted: boolean;
  onHighlight: (edgeKey: string | null) => void;
}) {
  const trend = getTrendDisplay(path.observationTrend);
  const hasWeakLink = path.weakestLinkKey && path.weakestLinkConfidence < 0.5;
  
  return (
    <div 
      className={`flex items-center gap-3 p-2 rounded-md transition-colors cursor-pointer ${
        isHighlighted 
          ? 'bg-accent-primary/20 border border-accent-primary/40' 
          : 'hover:bg-white/5'
      }`}
      onClick={() => onHighlight(isHighlighted ? null : path.weakestLinkKey)}
    >
      {/* Health score badge */}
      <div className={`flex-shrink-0 w-12 text-center py-1 rounded-md ${getHealthBgColor(path.healthScore)}`}>
        <span className={`text-xs font-semibold tabular-nums ${getHealthColor(path.healthScore)}`}>
          {formatHealthScore(path.healthScore)}
        </span>
      </div>
      
      {/* Path hops */}
      <div className="flex-1 flex items-center gap-0.5 overflow-x-auto min-w-0">
        {path.hops.map((hop, i) => (
          <span key={i} className="flex items-center">
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
              hasWeakLink && path.weakestLinkKey?.includes(hop)
                ? 'bg-accent-danger/20 text-accent-danger'
                : 'bg-white/10 text-text-secondary'
            }`}>
              {hop}
            </span>
            {i < path.hops.length - 1 && (
              <span className="text-text-muted mx-0.5">→</span>
            )}
          </span>
        ))}
      </div>
      
      {/* Metrics */}
      <div className="flex-shrink-0 flex items-center gap-3">
        {/* Route type indicator */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          path.routeType === 'direct' 
            ? 'bg-accent-success/20 text-accent-success' 
            : path.routeType === 'flood'
              ? 'bg-accent-primary/20 text-accent-primary'
              : 'bg-white/10 text-text-muted'
        }`}>
          {path.routeType === 'direct' ? 'D' : path.routeType === 'flood' ? 'F' : 'M'}
        </span>
        
        {/* Latency estimate */}
        <div className="flex items-center gap-1 text-text-muted" title="Estimated latency">
          <Zap className="w-3 h-3" />
          <span className="text-[10px] tabular-nums">{path.estimatedLatencyMs}ms</span>
        </div>
        
        {/* Observation count */}
        <div className="flex items-center gap-1 text-text-muted" title="Observations">
          <Activity className="w-3 h-3" />
          <span className="text-[10px] tabular-nums">{path.observationCount}</span>
        </div>
        
        {/* Trend indicator */}
        <div className={`flex items-center gap-1 ${trend.color}`} title="Usage trend">
          {trend.icon}
        </div>
        
        {/* Weak link warning */}
        {hasWeakLink && (
          <div className="text-accent-danger" title={`Weak link: ${path.weakestLinkConfidence.toFixed(0)}% confidence`}>
            <AlertTriangle className="w-3 h-3" />
          </div>
        )}
      </div>
    </div>
  );
});

export const PathHealthPanel = memo(function PathHealthPanel({
  maxPaths = 10,
  onHighlightEdge,
  highlightedEdge,
}: PathHealthPanelProps) {
  const pathHealth = usePathHealth();
  const [isExpanded, setIsExpanded] = useState(false);
  
  // Get top paths by health score
  const displayPaths = useMemo(() => {
    return pathHealth.slice(0, maxPaths);
  }, [pathHealth, maxPaths]);
  
  // Calculate summary stats
  const stats = useMemo(() => {
    if (pathHealth.length === 0) return null;
    
    const avgHealth = pathHealth.reduce((sum, p) => sum + p.healthScore, 0) / pathHealth.length;
    const declining = pathHealth.filter(p => p.observationTrend < -0.2).length;
    const weakLinks = pathHealth.filter(p => p.weakestLinkConfidence < 0.5).length;
    
    return { avgHealth, declining, weakLinks };
  }, [pathHealth]);
  
  // Handle edge highlight
  const handleHighlight = (edgeKey: string | null) => {
    onHighlightEdge?.(edgeKey);
  };
  
  if (pathHealth.length === 0) {
    return null;
  }
  
  return (
    <div className="chart-container">
      {/* Header - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full chart-header hover:bg-white/5 transition-colors rounded-t-lg cursor-pointer"
      >
        <div className="chart-title">
          <GitBranch className="chart-title-icon" />
          Path Health
          <span className="ml-2 text-[10px] font-normal text-text-muted">
            ({pathHealth.length} paths)
          </span>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Summary stats */}
          {stats && (
            <div className="flex items-center gap-3 text-[10px]">
              <span className={`tabular-nums ${getHealthColor(stats.avgHealth)}`}>
                Avg: {formatHealthScore(stats.avgHealth)}
              </span>
              {stats.weakLinks > 0 && (
                <span className="text-accent-danger flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {stats.weakLinks} weak
                </span>
              )}
              {stats.declining > 0 && (
                <span className="text-signal-poor flex items-center gap-1">
                  <TrendingDown className="w-3 h-3" />
                  {stats.declining} declining
                </span>
              )}
            </div>
          )}
          
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          )}
        </div>
      </button>
      
      {/* Expanded content */}
      {isExpanded && (
        <div className="p-3 pt-0 space-y-1">
          {/* Legend */}
          <div className="flex items-center gap-4 text-[10px] text-text-muted pb-2 border-b border-white/5">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-accent-success" /> Healthy (≥70%)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-accent-secondary" /> Fair (50-70%)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-signal-poor" /> Weak (30-50%)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-accent-danger" /> Critical (&lt;30%)
            </span>
          </div>
          
          {/* Path list */}
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {displayPaths.map((path) => (
              <PathRow
                key={path.pathKey}
                path={path}
                isHighlighted={highlightedEdge === path.weakestLinkKey}
                onHighlight={handleHighlight}
              />
            ))}
          </div>
          
          {pathHealth.length > maxPaths && (
            <div className="text-center text-[10px] text-text-muted pt-2">
              Showing top {maxPaths} of {pathHealth.length} paths
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default PathHealthPanel;
