/**
 * BestWorstLinkWidget - Displays best and worst neighbor links
 *
 * Shows the highest and lowest quality links among TRUE zero-hop neighbors,
 * useful for identifying network weak points.
 */

import { useNavigate } from 'react-router-dom';
import { Route } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Get status based on worst link score */
function getWorstLinkStatus(score: number): ComputedChannelHealth['status'] {
  if (score >= 60) return 'excellent';
  if (score >= 40) return 'good';
  if (score >= 25) return 'fair';
  if (score >= 10) return 'congested';
  return 'critical';
}

/** Truncate name to fit widget */
function truncateName(name: string, maxLen: number = 8): string {
  if (name.length <= maxLen) return name;
  return name.substring(0, maxLen - 1) + '…';
}

export function BestWorstLinkWidget() {
  const { linkQuality, isLoading, error } = useLBTData();
  const navigate = useNavigate();

  const best = linkQuality?.bestLink;
  const worst = linkQuality?.worstLink;
  const status = worst ? getWorstLinkStatus(worst.score) : 'unknown';

  // Custom content showing both links
  const linkDisplay = linkQuality && best && worst ? (
    <div className="flex flex-col gap-0.5 mt-auto">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Best:</span>
        <span className="font-mono text-signal-excellent">
          {truncateName(best.name)} ({Math.round(best.score)})
        </span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Worst:</span>
        <span className={`font-mono ${worst.score >= 40 ? 'text-signal-fair' : 'text-signal-critical'}`}>
          {truncateName(worst.name)} ({Math.round(worst.score)})
        </span>
      </div>
    </div>
  ) : linkQuality && linkQuality.neighborCount === 0 ? (
    <div className="flex items-center justify-center text-xs text-text-muted mt-auto">
      No direct neighbors
    </div>
  ) : null;

  return (
    <MiniWidget
      title="Link Range"
      icon={<Route className="mini-widget-icon" />}
      status={status}
      isLoading={isLoading}
      error={error}
      onClick={() => navigate('/contacts')}
    >
      {linkDisplay}
    </MiniWidget>
  );
}

export default BestWorstLinkWidget;
