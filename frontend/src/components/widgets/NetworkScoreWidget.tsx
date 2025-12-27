/**
 * NetworkScoreWidget - Displays average network link quality score
 *
 * Shows the mean quality score across TRUE zero-hop neighbors (QuickNeighbors).
 * These are nodes where we received ADVERTs with them as the last hop.
 */

import { useNavigate } from 'react-router-dom';
import { Network } from 'lucide-react';
import { MiniWidget } from './MiniWidget';
import { useLBTData, type ComputedChannelHealth } from './LBTDataContext';

/** Convert score (0-100) to status color */
function getScoreStatus(score: number): ComputedChannelHealth['status'] {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'congested';
  return 'critical';
}

export function NetworkScoreWidget() {
  const { linkQuality, trends, isLoading, error } = useLBTData();
  const navigate = useNavigate();

  const avgScore = linkQuality?.networkScore ?? 0;
  // Use neighborCount from linkQuality - this is TRUE zero-hop count
  const neighborCount = linkQuality?.neighborCount ?? 0;
  const status = linkQuality ? getScoreStatus(avgScore) : 'unknown';
  const trend = trends?.networkScore.trend;

  return (
    <MiniWidget
      title="Network Score"
      icon={<Network className="mini-widget-icon" />}
      value={Math.round(avgScore)}
      unit="/100"
      status={status}
      trend={trend}
      subtitle={linkQuality ? `${neighborCount} direct neighbor${neighborCount !== 1 ? 's' : ''}` : undefined}
      isLoading={isLoading}
      error={error}
      onClick={() => navigate('/contacts')}
    />
  );
}

export default NetworkScoreWidget;
