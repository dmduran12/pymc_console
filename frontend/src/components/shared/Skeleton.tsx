import clsx from 'clsx';
import type { CSSProperties } from 'react';

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

/** Base skeleton pulse animation element */
export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-white/[0.06] rounded',
        className
      )}
      style={style}
    />
  );
}

/** Skeleton for a single log row - matches LogRow layout */
export function LogRowSkeleton() {
  return (
    <div className="p-3 rounded-lg border border-border-subtle bg-bg-subtle">
      <div className="flex items-start gap-3">
        {/* Level badge */}
        <Skeleton className="w-14 h-6 rounded shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          {/* Message line 1 */}
          <Skeleton className="h-4 w-full" />
          {/* Message line 2 (shorter) */}
          <Skeleton className="h-4 w-3/4" />
          {/* Timestamp */}
          <Skeleton className="h-3 w-32 mt-1" />
        </div>
      </div>
    </div>
  );
}

/** Multiple log row skeletons for initial loading state */
export function LogsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <LogRowSkeleton key={i} />
      ))}
    </div>
  );
}

/** Skeleton for a stats card */
export function StatsCardSkeleton() {
  return (
    <div className="glass-card card-padding">
      <div className="space-y-3">
        {/* Title */}
        <Skeleton className="h-4 w-24" />
        {/* Value */}
        <Skeleton className="h-8 w-20" />
        {/* Subtitle */}
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

// Pre-computed heights for chart skeleton bars (stable across renders)
const CHART_BAR_HEIGHTS = [45, 72, 33, 58, 80, 42, 65, 28, 55, 75, 38, 62];

/** Skeleton for chart area */
export function ChartSkeleton({ height = 'h-64' }: { height?: string }) {
  return (
    <div className={clsx('glass-card card-padding', height)}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-32" />
        </div>
        {/* Chart area */}
        <div className="flex-1 flex items-end gap-1 pb-4">
          {CHART_BAR_HEIGHTS.map((h, i) => (
            <Skeleton
              key={i}
              className="flex-1"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Skeleton for neighbor/packet list row */
export function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-4 py-3 px-4">
      {/* Icon */}
      <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
      {/* Content */}
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
      </div>
      {/* Metrics */}
      <Skeleton className="w-16 h-4" />
    </div>
  );
}

/** Skeleton for packet list */
export function PacketListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-border-subtle">
      {Array.from({ length: count }).map((_, i) => (
        <ListRowSkeleton key={i} />
      ))}
    </div>
  );
}
