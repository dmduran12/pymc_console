/**
 * PageSkeleton - Loading placeholder for lazy-loaded routes
 * 
 * Provides a consistent loading experience during route transitions.
 * Uses CSS animations for shimmer effect without JS overhead.
 */

/**
 * Generic skeleton pulse animation class.
 * Reuses Tailwind's animate-pulse for consistent shimmer effect.
 */
function SkeletonBlock({ className = '' }: { className?: string }) {
  return (
    <div 
      className={`bg-white/5 animate-pulse rounded-lg ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * Dashboard-style skeleton with hero card, widget row, and grid cards.
 */
export function DashboardSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading dashboard">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-8 w-48" />
        <SkeletonBlock className="h-8 w-32" />
      </div>
      
      {/* Hero card */}
      <SkeletonBlock className="h-72" />
      
      {/* Widget row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-24" />
        ))}
      </div>
      
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-44" />
        ))}
      </div>
      
      {/* Recent packets */}
      <SkeletonBlock className="h-96" />
    </div>
  );
}

/**
 * List-style skeleton for Packets, Logs pages.
 */
export function ListSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading list">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-8 w-40" />
        <SkeletonBlock className="h-8 w-24" />
      </div>
      
      {/* Filters */}
      <SkeletonBlock className="h-20" />
      
      {/* List items */}
      <div className="glass-card overflow-hidden">
        {/* Table header */}
        <SkeletonBlock className="h-10 rounded-none" />
        
        {/* Rows */}
        <div className="divide-y divide-border-subtle/30">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="px-4 py-3">
              <SkeletonBlock className="h-6" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Map-style skeleton for Contacts page.
 */
export function MapSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading map">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-8 w-32" />
        <SkeletonBlock className="h-6 w-48" />
      </div>
      
      {/* Map */}
      <SkeletonBlock className="h-[500px]" />
      
      {/* Contacts list */}
      <SkeletonBlock className="h-64" />
    </div>
  );
}

/**
 * Chart-style skeleton for Statistics page.
 */
export function ChartSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading charts">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-8 w-36" />
        <SkeletonBlock className="h-8 w-40" />
      </div>
      
      {/* Chart cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SkeletonBlock className="h-80" />
        <SkeletonBlock className="h-80" />
      </div>
      
      <SkeletonBlock className="h-64" />
    </div>
  );
}

/**
 * Form-style skeleton for Settings page.
 */
export function FormSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading settings">
      {/* Header */}
      <SkeletonBlock className="h-8 w-32" />
      
      {/* Form sections */}
      <div className="space-y-6">
        <SkeletonBlock className="h-48" />
        <SkeletonBlock className="h-64" />
        <SkeletonBlock className="h-32" />
      </div>
    </div>
  );
}

/**
 * System-style skeleton for System page.
 */
export function SystemSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading system info">
      {/* Header */}
      <SkeletonBlock className="h-8 w-28" />
      
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-28" />
        ))}
      </div>
      
      {/* Charts */}
      <SkeletonBlock className="h-64" />
      <SkeletonBlock className="h-48" />
    </div>
  );
}

/**
 * Default page skeleton - generic layout.
 * Used as fallback when specific skeleton not needed.
 */
export default function PageSkeleton() {
  return (
    <div className="section-gap" aria-label="Loading page">
      <SkeletonBlock className="h-8 w-40" />
      <SkeletonBlock className="h-64" />
      <SkeletonBlock className="h-48" />
    </div>
  );
}
