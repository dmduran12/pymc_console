import { useEffect, useState, useCallback, useMemo } from 'react';
import { useStats, useStatsError, useFlashReceived } from '@/lib/stores/useStore';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { StatsCard } from '@/components/stats/StatsCard';
import { RecentPackets } from '@/components/packets/RecentPackets';
import { TimeRangeSelector } from '@/components/shared/TimeRangeSelector';
import { SimpleTooltip } from '@/components/charts/ChartTooltip';
import { formatUptime } from '@/lib/format';
import { DASHBOARD_TIME_RANGES, METRIC_COLORS, POLLING_INTERVALS } from '@/lib/constants';
import { getBucketedStats, type BucketedStats, type BucketData } from '@/lib/api';
import { Home, Radio, TrendingUp, ArrowUpRight, XCircle, Clock } from 'lucide-react';
import { HashBadge } from '@/components/ui/HashBadge';
import { TxDelayCard } from '@/components/stats/TxDelayCard';
import { WidgetRow } from '@/components/widgets';
import { PageContainer, PageHeader, Grid12, GridCell, Card } from '@/components/layout/PageLayout';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

/** Transform bucket data for AreaChart */
function transformBucketsForChart(
  buckets: BucketData[] | undefined,
  rangeMinutes: number
): { time: string; received: number }[] {
  if (!buckets || buckets.length === 0) return [];
  
  // For ranges > 24h, show day + time; otherwise just time
  const showDate = rangeMinutes > 1440;
  
  return buckets.map((bucket) => {
    const date = new Date(bucket.start * 1000);
    const time = showDate
      ? date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return {
      time,
      received: bucket.count,
    };
  });
}

export default function Dashboard() {
  const stats = useStats();
  const statsError = useStatsError();
  const flashReceived = useFlashReceived();
  const [selectedRange, setSelectedRange] = useState(0); // Default to 20m
  const [bucketedStats, setBucketedStats] = useState<BucketedStats | null>(null);
  const [isFlashing, setIsFlashing] = useState(false);
  
  // Debounce time range changes to prevent rapid API calls
  const debouncedRange = useDebounce(selectedRange, 150);
  
  // Current time range config
  const currentRange = DASHBOARD_TIME_RANGES[selectedRange];
  
  // Transform received buckets for the hero chart (must be before early return)
  const receivedChartData = useMemo(
    () => transformBucketsForChart(bucketedStats?.received, currentRange.minutes),
    [bucketedStats?.received, currentRange.minutes]
  );
  
  // Calculate tick interval based on data length - show ~6-8 labels max
  const xAxisTickInterval = useMemo(() => {
    const len = receivedChartData.length;
    if (len <= 12) return 0; // Show all
    if (len <= 24) return 2; // Every 3rd
    if (len <= 48) return 5; // Every 6th
    if (len <= 72) return 8; // Every 9th (~8 labels)
    return Math.floor(len / 7); // ~7 labels
  }, [receivedChartData.length]);
  
  // Fetch bucketed stats
  const fetchBucketedStats = useCallback(async () => {
    try {
      const range = DASHBOARD_TIME_RANGES[debouncedRange];
      const response = await getBucketedStats(range.minutes, range.buckets);
      if (response.success && response.data) {
        setBucketedStats(response.data);
      }
    } catch {
      // Silently fail - stats will show stale data
    }
  }, [debouncedRange]);
  
  // Fetch on mount and when range changes
  useEffect(() => {
    const controller = new AbortController();
    const doFetch = async () => {
      await fetchBucketedStats();
    };
    void doFetch();
    const interval = setInterval(() => void doFetch(), POLLING_INTERVALS.charts);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [fetchBucketedStats]);
  
  // Flash effect when new packet received
  useEffect(() => {
    if (flashReceived > 0) {
      // Use requestAnimationFrame to avoid synchronous setState in effect
      const raf = requestAnimationFrame(() => setIsFlashing(true));
      const timer = setTimeout(() => setIsFlashing(false), 600);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [flashReceived]);

  // Derived values
  const uptime = stats?.uptime_seconds ? formatUptime(stats.uptime_seconds) : '0m';
  const nodeName = stats?.node_name || stats?.config?.node_name || 'Unknown Node';
  
  // Calculate totals from bucketed data (time-range specific)
  const bucketTotals = useMemo(() => {
    const received = bucketedStats?.received?.reduce((sum, b) => sum + b.count, 0) ?? 0;
    const forwarded = bucketedStats?.forwarded?.reduce((sum, b) => sum + b.count, 0) ?? 0;
    const dropped = bucketedStats?.dropped?.reduce((sum, b) => sum + b.count, 0) ?? 0;
    const transmitted = bucketedStats?.transmitted?.reduce((sum, b) => sum + b.count, 0) ?? 0;
    
    // Calculate hourly rate from the time range
    const timeRangeMinutes = bucketedStats?.time_range_minutes ?? currentRange.minutes;
    const hours = timeRangeMinutes / 60;
    const rxPerHour = hours > 0 ? Math.round(received / hours) : 0;
    const fwdPerHour = hours > 0 ? Math.round(forwarded / hours) : 0;
    
    return { received, forwarded, dropped, transmitted, rxPerHour, fwdPerHour };
  }, [bucketedStats, currentRange.minutes]);

  if (statsError) {
    return (
      <Card className="p-8 text-center">
        <p className="type-subheading text-accent-red mb-2">Failed to connect to backend</p>
        <p className="type-body text-white/50">{statsError}</p>
        <p className="type-data-sm text-white/40 mt-4">
          Make sure the Python backend is running on port 8000
        </p>
      </Card>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={nodeName}
        icon={<Home />}
        controls={
          <TimeRangeSelector
            ranges={DASHBOARD_TIME_RANGES}
            selectedIndex={selectedRange}
            onSelect={setSelectedRange}
          />
        }
      />
      
      {/* Hero Received Card - Full Width */}
      <Card>
        {isFlashing && <div className="flash-overlay" />}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1 sm:mb-2">
              <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-accent-success" />
              <span className="type-label text-text-muted">RECEIVED</span>
              <span className="pill-tag">{currentRange.label}</span>
            </div>
            <div className="text-3xl sm:text-4xl md:type-hero font-semibold" style={{ color: METRIC_COLORS.received }}>
              {bucketTotals.received.toLocaleString()}
            </div>
            <div className="type-body-sm text-text-muted mt-0.5 sm:mt-1">
              {bucketTotals.rxPerHour}/hr rate
            </div>
          </div>
        </div>
        
        {/* Area Chart */}
        {receivedChartData.length > 0 ? (
          <div className="h-48 mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={receivedChartData}>
                <defs>
                  <linearGradient id="gradient-received" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={METRIC_COLORS.received} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={METRIC_COLORS.received} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis 
                  dataKey="time" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
                  dy={8}
                  interval={xAxisTickInterval}
                  minTickGap={20}
                />
                <YAxis 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
                  dx={-8}
                  width={40}
                />
                <Tooltip
                  content={
                    <SimpleTooltip
                      color={METRIC_COLORS.received}
                      labelKey="time"
                      unit=" packets"
                    />
                  }
                  cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1 }}
                />
                <Area
                  type="stepAfter"
                  dataKey="received"
                  stroke={METRIC_COLORS.received}
                  fill="url(#gradient-received)"
                  strokeWidth={1}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0, fill: METRIC_COLORS.received }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-text-muted">
            No data available for this time range
          </div>
        )}
      </Card>

      {/* LBT Insights Widget Row */}
      <WidgetRow />

      {/* Stats Grid - Secondary Row (4 cards) */}
      <Grid12>
        <GridCell span={6} md={3}>
          <StatsCard
            title="FORWARDED"
            value={bucketTotals.forwarded}
            subtitle={`${bucketTotals.fwdPerHour}/hr rate`}
            color="forwarded"
            buckets={bucketedStats?.forwarded}
            timeRangeLabel={currentRange.label}
            icon={<ArrowUpRight className="w-4 h-4" />}
          />
        </GridCell>
        <GridCell span={6} md={3}>
          <StatsCard
            title="DROPPED"
            value={bucketTotals.dropped}
            subtitle="Filtered or duplicate"
            color="dropped"
            buckets={bucketedStats?.dropped}
            timeRangeLabel={currentRange.label}
            icon={<XCircle className="w-4 h-4" />}
          />
        </GridCell>
        <GridCell span={6} md={3}>
          <TxDelayCard 
            stats={stats}
            receivedBuckets={bucketedStats?.received}
            droppedBuckets={bucketedStats?.dropped}
            forwardedBuckets={bucketedStats?.forwarded}
            bucketDurationSeconds={bucketedStats?.bucket_duration_seconds}
            timeRangeLabel={currentRange.label}
          />
        </GridCell>
        <GridCell span={6} md={3}>
          <StatsCard
            title="UPTIME"
            value={uptime}
            subtitle="Since last restart"
            color="neutral"
            icon={<Clock className="w-4 h-4" />}
          />
        </GridCell>
      </Grid12>

      {/* Recent Packets - full width now that controls moved to sidebar */}
      <RecentPackets />

      {/* Node Info */}
      {stats && (
        <Card>
          <h3 className="type-subheading text-text-primary mb-4 flex items-center gap-2">
            <Radio className="w-5 h-5 text-accent-primary" />
            Node Information
          </h3>
          <Grid12>
            <GridCell sm={6} lg={3}>
              <span className="type-label text-text-muted">Node Name</span>
              <p className="type-body text-text-primary mt-1">{nodeName}</p>
            </GridCell>
            <GridCell sm={6} lg={3}>
              <span className="type-label text-text-muted">Version</span>
              <p className="type-data text-text-primary mt-1">v{stats.version}</p>
            </GridCell>
            <GridCell sm={6} lg={3}>
              <span className="type-label text-text-muted">Core Version</span>
              <p className="type-data text-text-primary mt-1">v{stats.core_version}</p>
            </GridCell>
            <GridCell sm={6} lg={3}>
              <span className="type-label text-text-muted">Local Hash</span>
              <div className="mt-1">
                {stats.local_hash ? (
                  <HashBadge hash={stats.local_hash} size="sm" />
                ) : (
                  <span className="type-data-sm text-text-muted">N/A</span>
                )}
              </div>
            </GridCell>
          </Grid12>
          {/* Public Key - full width row */}
          {stats.public_key && (
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <span className="type-label text-text-muted">Public Key</span>
              <div className="mt-1">
                <HashBadge hash={stats.public_key} prefixLength={12} suffixLength={8} />
              </div>
            </div>
          )}
        </Card>
      )}
    </PageContainer>
  );
}
