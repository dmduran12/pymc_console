/**
 * MiniWidget - Base component for compact dashboard insight widgets
 *
 * These small cards display real-time LBT, noise floor, and link quality metrics.
 * Designed for the top row of the dashboard with responsive 8→4→2 column layout.
 *
 * @example
 * <MiniWidget
 *   title="LBT Retries"
 *   value="2.4"
 *   unit="%"
 *   status="good"
 *   subtitle="Avg 45ms backoff"
 *   icon={<RefreshCw className="mini-widget-icon" />}
 * />
 */

import type { ReactNode } from 'react';

/** Widget status types for color coding */
export type WidgetStatus = 'excellent' | 'good' | 'fair' | 'congested' | 'critical' | 'unknown';

export interface MiniWidgetProps {
  /** Widget title (displays in header) */
  title: string;
  /** Optional icon element (should use mini-widget-icon class) */
  icon?: ReactNode;
  /** Primary metric value to display */
  value?: string | number;
  /** Unit suffix (%, ms, dBm, etc.) */
  unit?: string;
  /** Value size variant */
  valueSize?: 'sm' | 'md' | 'lg';
  /** Color status for the value */
  status?: WidgetStatus;
  /** Subtitle text below the value */
  subtitle?: string;
  /** Trend indicator: up (worse), down (better), or stable */
  trend?: 'up' | 'down' | 'stable';
  /** Optional sparkline or custom content */
  children?: ReactNode;
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string | null;
  /** Additional className */
  className?: string;
  /** Click handler */
  onClick?: () => void;
}

/**
 * Get CSS class for value based on status
 */
function getValueStatusClass(status?: WidgetStatus): string {
  if (!status || status === 'unknown') return '';
  return status;
}

/**
 * Trend icon component
 */
function TrendIndicator({ trend }: { trend: 'up' | 'down' | 'stable' }) {
  if (trend === 'stable') {
    return (
      <span className="mini-widget-trend stable">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
        </svg>
      </span>
    );
  }

  if (trend === 'up') {
    return (
      <span className="mini-widget-trend up">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </span>
    );
  }

  return (
    <span className="mini-widget-trend down">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  );
}

/**
 * Loading spinner for widget
 */
function LoadingSpinner() {
  return (
    <div className="mini-widget-loading">
      <div className="mini-widget-loading-spinner" />
    </div>
  );
}

/**
 * Error display for widget
 */
function ErrorDisplay({ message }: { message: string }) {
  return (
    <div className="mini-widget-error">
      <span title={message}>No data</span>
    </div>
  );
}

export function MiniWidget({
  title,
  icon,
  value,
  unit,
  valueSize = 'md',
  status,
  subtitle,
  trend,
  children,
  isLoading = false,
  error,
  className = '',
  onClick,
}: MiniWidgetProps) {
  const valueClasses = [
    'mini-widget-value',
    valueSize === 'lg' && 'mini-widget-value-lg',
    valueSize === 'sm' && 'mini-widget-value-sm',
    getValueStatusClass(status),
  ]
    .filter(Boolean)
    .join(' ');

  const widgetClasses = ['mini-widget glass-card', onClick && 'cursor-pointer', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={widgetClasses} onClick={onClick} role={onClick ? 'button' : undefined}>
      {/* Header */}
      <div className="mini-widget-header">
        {icon}
        <span className="mini-widget-title">{title}</span>
        {status && status !== 'unknown' && (
          <div className={`mini-widget-status-dot ${status}`} />
        )}
        {trend && <TrendIndicator trend={trend} />}
      </div>

      {/* Content */}
      {isLoading ? (
        <LoadingSpinner />
      ) : error ? (
        <ErrorDisplay message={error} />
      ) : (
        <>
          {/* Value */}
          {value !== undefined && (
            <div className={valueClasses}>
              {value}
              {unit && <span className="mini-widget-unit">{unit}</span>}
            </div>
          )}

          {/* Subtitle */}
          {subtitle && <div className="mini-widget-subtitle">{subtitle}</div>}

          {/* Custom content (sparklines, etc.) */}
          {children}
        </>
      )}
    </div>
  );
}

export default MiniWidget;
