/**
 * LBTDataContext - Shared data context for LBT Insights widgets
 *
 * Consolidates API calls to prevent redundant fetching across widgets.
 * Fetches at highest frequency (15s for channel_health), then provides
 * data to all widgets from a single source.
 *
 * Data structure:
 * - lbtStats: 24h LBT statistics (retry rate, busy events, backoff)
 * - noiseFloor: 24h noise floor with trend
 * - linkQuality: Link quality scores for all neighbors
 * - channelHealth: 1h composite health (real-time)
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  getLBTStats,
  getNoiseFloorStatsExtended,
  getLinkQualityScores,
  getChannelHealth,
} from '@/lib/api';
import type {
  LBTStats,
  NoiseFloorStatsExtended,
  LinkQualityResponse,
  ChannelHealthResponse,
} from '@/types/api';

/** Refresh intervals */
const REFRESH_INTERVAL_FAST = 15000; // 15s for real-time health
const REFRESH_INTERVAL_SLOW = 60000; // 60s for 24h trend data

/** Context data shape */
export interface LBTData {
  // 24h trend data (refreshed every 60s)
  lbtStats: LBTStats | null;
  noiseFloor: NoiseFloorStatsExtended | null;
  linkQuality: LinkQualityResponse | null;

  // Real-time health (refreshed every 15s)
  channelHealth: ChannelHealthResponse | null;

  // Loading states
  isLoading: boolean;
  isTrendLoading: boolean;
  isHealthLoading: boolean;

  // Error state
  error: string | null;

  // Manual refresh
  refresh: () => Promise<void>;
}

const defaultData: LBTData = {
  lbtStats: null,
  noiseFloor: null,
  linkQuality: null,
  channelHealth: null,
  isLoading: true,
  isTrendLoading: true,
  isHealthLoading: true,
  error: null,
  refresh: async () => {},
};

const LBTDataContext = createContext<LBTData>(defaultData);

export interface LBTDataProviderProps {
  children: ReactNode;
}

export function LBTDataProvider({ children }: LBTDataProviderProps) {
  // 24h trend data
  const [lbtStats, setLbtStats] = useState<LBTStats | null>(null);
  const [noiseFloor, setNoiseFloor] = useState<NoiseFloorStatsExtended | null>(null);
  const [linkQuality, setLinkQuality] = useState<LinkQualityResponse | null>(null);

  // Real-time health
  const [channelHealth, setChannelHealth] = useState<ChannelHealthResponse | null>(null);

  // Loading states
  const [isTrendLoading, setIsTrendLoading] = useState(true);
  const [isHealthLoading, setIsHealthLoading] = useState(true);

  // Error
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch 24h trend data (LBT stats, noise floor, link quality)
   * Called every 60s - these metrics don't need real-time updates
   */
  const fetchTrendData = useCallback(async () => {
    try {
      const [lbtRes, noiseRes, linkRes] = await Promise.all([
        getLBTStats(24),
        getNoiseFloorStatsExtended(24),
        getLinkQualityScores(),
      ]);

      if (lbtRes.success && lbtRes.data) {
        setLbtStats(lbtRes.data);
      }
      if (noiseRes.success && noiseRes.data) {
        setNoiseFloor(noiseRes.data);
      }
      if (linkRes.success && linkRes.data) {
        setLinkQuality(linkRes.data);
      }

      // Clear error on success
      if (lbtRes.success || noiseRes.success || linkRes.success) {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trend data');
    } finally {
      setIsTrendLoading(false);
    }
  }, []);

  /**
   * Fetch real-time channel health (1h window)
   * Called every 15s for responsive health indicator
   */
  const fetchHealthData = useCallback(async () => {
    try {
      const res = await getChannelHealth();
      if (res.success && res.data) {
        setChannelHealth(res.data);
        setError(null);
      }
    } catch (err) {
      // Don't override trend data errors
      if (!lbtStats && !noiseFloor && !linkQuality) {
        setError(err instanceof Error ? err.message : 'Failed to fetch health data');
      }
    } finally {
      setIsHealthLoading(false);
    }
  }, [lbtStats, noiseFloor, linkQuality]);

  /**
   * Manual refresh - fetches all data
   */
  const refresh = useCallback(async () => {
    setIsTrendLoading(true);
    setIsHealthLoading(true);
    await Promise.all([fetchTrendData(), fetchHealthData()]);
  }, [fetchTrendData, fetchHealthData]);

  // Initial fetch and intervals
  useEffect(() => {
    // Initial fetch
    void fetchTrendData();
    void fetchHealthData();

    // Set up intervals
    const trendInterval = setInterval(() => void fetchTrendData(), REFRESH_INTERVAL_SLOW);
    const healthInterval = setInterval(() => void fetchHealthData(), REFRESH_INTERVAL_FAST);

    return () => {
      clearInterval(trendInterval);
      clearInterval(healthInterval);
    };
  }, [fetchTrendData, fetchHealthData]);

  const value: LBTData = {
    lbtStats,
    noiseFloor,
    linkQuality,
    channelHealth,
    isLoading: isTrendLoading && isHealthLoading,
    isTrendLoading,
    isHealthLoading,
    error,
    refresh,
  };

  return <LBTDataContext.Provider value={value}>{children}</LBTDataContext.Provider>;
}

/**
 * Hook to access LBT data from context
 */
export function useLBTData(): LBTData {
  const context = useContext(LBTDataContext);
  if (context === undefined) {
    throw new Error('useLBTData must be used within an LBTDataProvider');
  }
  return context;
}

export default LBTDataContext;
