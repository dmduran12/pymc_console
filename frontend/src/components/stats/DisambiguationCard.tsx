/**
 * DisambiguationCard
 * 
 * Displays prefix disambiguation statistics for the mesh topology.
 * Shows collision rate, average confidence, and worst-colliding prefixes.
 */

import { AlertTriangle, CheckCircle, Info, Hash } from 'lucide-react';
import { useDisambiguationStats, useHasDisambiguationData } from '@/lib/stores/useTopologyStore';

// Confidence level thresholds
const CONFIDENCE_EXCELLENT = 0.9;
const CONFIDENCE_GOOD = 0.7;
const CONFIDENCE_FAIR = 0.5;

// Collision rate thresholds (percentage)
const COLLISION_RATE_LOW = 10;
const COLLISION_RATE_MEDIUM = 25;

/**
 * Get status color based on average confidence
 */
function getConfidenceStatus(confidence: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (confidence >= CONFIDENCE_EXCELLENT) return 'excellent';
  if (confidence >= CONFIDENCE_GOOD) return 'good';
  if (confidence >= CONFIDENCE_FAIR) return 'fair';
  return 'poor';
}

/**
 * Get status color based on collision rate
 */
function getCollisionStatus(rate: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (rate <= COLLISION_RATE_LOW) return 'excellent';
  if (rate <= COLLISION_RATE_MEDIUM) return 'good';
  return 'poor';
}

// Status colors using theme variables
const STATUS_COLORS = {
  excellent: 'text-signal-excellent',
  good: 'text-signal-good',
  fair: 'text-signal-fair',
  poor: 'text-signal-poor',
};

const STATUS_BG_COLORS = {
  excellent: 'bg-signal-excellent/10',
  good: 'bg-signal-good/10',
  fair: 'bg-signal-fair/10',
  poor: 'bg-signal-poor/10',
};

/**
 * Progress bar for visualizing a 0-100 percentage
 */
function ProgressBar({ 
  value, 
  status 
}: { 
  value: number; 
  status: 'excellent' | 'good' | 'fair' | 'poor';
}) {
  const barColor = {
    excellent: 'bg-signal-excellent',
    good: 'bg-signal-good',
    fair: 'bg-signal-fair',
    poor: 'bg-signal-poor',
  }[status];
  
  return (
    <div className="w-full h-2 bg-surface-elevated rounded-full overflow-hidden">
      <div 
        className={`h-full ${barColor} transition-all duration-300`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/**
 * Main disambiguation card component
 */
export function DisambiguationCard() {
  const stats = useDisambiguationStats();
  const hasData = useHasDisambiguationData();
  
  if (!hasData) {
    return (
      <div className="data-card flex flex-col min-h-[200px]">
        <div className="flex items-center gap-2 mb-3">
          <Hash className="w-4 h-4 text-accent-primary" />
          <span className="data-card-title">Prefix Disambiguation</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-text-muted">
            <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="type-data-xs">No topology data available</p>
            <p className="type-data-xs opacity-70">Run deep analysis to see stats</p>
          </div>
        </div>
      </div>
    );
  }
  
  const confidenceStatus = getConfidenceStatus(stats.avgConfidence);
  const collisionStatus = getCollisionStatus(stats.collisionRate);
  
  // Overall health based on both metrics
  const overallHealth = confidenceStatus === 'poor' || collisionStatus === 'poor' 
    ? 'poor'
    : confidenceStatus === 'fair' || collisionStatus === 'fair'
      ? 'fair'
      : confidenceStatus === 'good' || collisionStatus === 'good'
        ? 'good'
        : 'excellent';
  
  const StatusIcon = overallHealth === 'excellent' || overallHealth === 'good'
    ? CheckCircle
    : AlertTriangle;
  
  return (
    <div className="data-card flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Hash className="w-4 h-4 text-accent-primary" />
          <span className="data-card-title">Prefix Disambiguation</span>
        </div>
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded ${STATUS_BG_COLORS[overallHealth]}`}>
          <StatusIcon className={`w-3.5 h-3.5 ${STATUS_COLORS[overallHealth]}`} />
          <span className={`type-data-xs font-medium ${STATUS_COLORS[overallHealth]}`}>
            {overallHealth === 'excellent' ? 'Excellent' : 
             overallHealth === 'good' ? 'Good' :
             overallHealth === 'fair' ? 'Fair' : 'Needs Attention'}
          </span>
        </div>
      </div>
      
      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Average Confidence */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="type-data-xs text-text-muted">Avg Confidence</span>
            <span className={`type-data-lg font-semibold ${STATUS_COLORS[confidenceStatus]}`}>
              {(stats.avgConfidence * 100).toFixed(1)}%
            </span>
          </div>
          <ProgressBar value={stats.avgConfidence * 100} status={confidenceStatus} />
        </div>
        
        {/* Collision Rate */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="type-data-xs text-text-muted">Collision Rate</span>
            <span className={`type-data-lg font-semibold ${STATUS_COLORS[collisionStatus]}`}>
              {stats.collisionRate.toFixed(1)}%
            </span>
          </div>
          <ProgressBar value={stats.collisionRate} status={collisionStatus} />
        </div>
      </div>
      
      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-2 mb-4 py-3 border-t border-b border-border-subtle">
        <div className="text-center">
          <div className="type-data-lg font-semibold text-text-primary">{stats.totalPrefixes}</div>
          <div className="type-data-xs text-text-muted">Prefixes</div>
        </div>
        <div className="text-center">
          <div className="type-data-lg font-semibold text-signal-good">{stats.unambiguousPrefixes}</div>
          <div className="type-data-xs text-text-muted">Unique</div>
        </div>
        <div className="text-center">
          <div className={`type-data-lg font-semibold ${stats.collisionPrefixes > 0 ? 'text-signal-fair' : 'text-text-primary'}`}>
            {stats.collisionPrefixes}
          </div>
          <div className="type-data-xs text-text-muted">Collisions</div>
        </div>
      </div>
      
      {/* High Collision Prefixes */}
      {stats.highCollisionPrefixes.length > 0 && (
        <div className="mb-3">
          <div className="type-data-xs text-text-muted mb-2">Highest Collisions</div>
          <div className="flex flex-wrap gap-1.5">
            {stats.highCollisionPrefixes.map(({ prefix, candidateCount }) => (
              <span 
                key={prefix}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-elevated text-text-secondary type-data-xs font-mono"
                title={`${candidateCount} candidates match this prefix`}
              >
                {prefix}
                <span className="text-signal-fair">×{candidateCount}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      
      {/* Low Confidence Warning */}
      {stats.lowConfidencePrefixes.length > 0 && (
        <div className="mt-auto pt-3 border-t border-border-subtle">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-signal-poor mt-0.5 flex-shrink-0" />
            <div>
              <div className="type-data-xs text-signal-poor font-medium">
                {stats.lowConfidencePrefixes.length} prefix{stats.lowConfidencePrefixes.length !== 1 ? 'es' : ''} with low confidence
              </div>
              <div className="type-data-xs text-text-muted mt-0.5">
                {stats.lowConfidencePrefixes.slice(0, 5).join(', ')}
                {stats.lowConfidencePrefixes.length > 5 && ` +${stats.lowConfidencePrefixes.length - 5} more`}
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* All Good State */}
      {stats.lowConfidencePrefixes.length === 0 && stats.collisionPrefixes === 0 && (
        <div className="mt-auto pt-3 border-t border-border-subtle">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-3.5 h-3.5 text-signal-excellent" />
            <span className="type-data-xs text-signal-excellent">
              All prefixes uniquely identified
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
