/**
 * PageLayout - Centralized layout components for consistent page structure.
 * 
 * This is the SINGLE SOURCE OF TRUTH for all page layouts.
 * All pages should use these components instead of raw CSS classes.
 * 
 * Layout System:
 * - PageContainer: Outer wrapper with consistent vertical spacing (section-gap)
 * - PageHeader: Title + optional controls row
 * - Grid12: 12-column grid system with responsive gaps
 * - GridCell: Column span utilities with breakpoint support
 * - Card: Glass card with responsive padding
 */

import { type ReactNode } from 'react';
import clsx from 'clsx';

// ============================================================================
// PageContainer - Main wrapper for all pages
// ============================================================================

interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * Main page wrapper with consistent vertical spacing.
 * All pages should wrap their content in this component.
 */
export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className={clsx('section-gap', className)}>
      {children}
    </div>
  );
}

// ============================================================================
// PageHeader - Consistent header with title and optional controls
// ============================================================================

interface PageHeaderProps {
  /** Page title text */
  title: string;
  /** Icon component to display before title */
  icon?: ReactNode;
  /** Optional right-side controls (time selectors, buttons, etc.) */
  controls?: ReactNode;
  /** Optional subtitle or secondary info below title row */
  subtitle?: ReactNode;
}

/**
 * Page header with title, icon, and optional controls.
 * Handles responsive layout: stacked on mobile, inline on desktop.
 */
export function PageHeader({ title, icon, controls, subtitle }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          {icon && <span className="w-6 h-6 text-accent-primary flex-shrink-0">{icon}</span>}
          {title}
        </h1>
        {controls && <div className="flex items-center gap-2 sm:gap-3">{controls}</div>}
      </div>
      {subtitle && <div>{subtitle}</div>}
    </div>
  );
}

// ============================================================================
// Grid12 - 12-column grid system
// ============================================================================

interface Grid12Props {
  children: ReactNode;
  className?: string;
}

/**
 * 12-column grid with responsive gaps.
 * - Mobile: 1rem (16px) gap
 * - Desktop: 1.5rem (24px) gap
 */
export function Grid12({ children, className }: Grid12Props) {
  return (
    <div className={clsx('grid-12', className)}>
      {children}
    </div>
  );
}

// ============================================================================
// GridCell - Column span wrapper
// ============================================================================

type ColSpan = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 'full';

interface GridCellProps {
  children: ReactNode;
  /** Column span at mobile (default) */
  span?: ColSpan;
  /** Column span at sm breakpoint (640px) */
  sm?: ColSpan;
  /** Column span at md breakpoint (768px) */
  md?: ColSpan;
  /** Column span at lg breakpoint (1024px) */
  lg?: ColSpan;
  /** Column span at xl breakpoint (1280px) */
  xl?: ColSpan;
  className?: string;
}

const spanClass = (span: ColSpan, prefix?: string): string => {
  const p = prefix ? `${prefix}:` : '';
  if (span === 'full') return `${p}col-span-full`;
  return `${p}col-span-${span}`;
};

/**
 * Grid cell with responsive column spans.
 * Defaults to full width if no span specified.
 * 
 * @example
 * // Full width on mobile, half on md, third on lg
 * <GridCell span="full" md={6} lg={4}>...</GridCell>
 */
export function GridCell({ children, span = 'full', sm, md, lg, xl, className }: GridCellProps) {
  const classes = clsx(
    spanClass(span),
    sm && spanClass(sm, 'sm'),
    md && spanClass(md, 'md'),
    lg && spanClass(lg, 'lg'),
    xl && spanClass(xl, 'xl'),
    className
  );
  
  return <div className={classes}>{children}</div>;
}

// ============================================================================
// Card - Glass card with responsive padding
// ============================================================================

interface CardProps {
  children: ReactNode;
  /** Use compact padding (card-padding-sm) */
  compact?: boolean;
  /** Skip padding entirely */
  noPadding?: boolean;
  className?: string;
}

/**
 * Glass card with consistent styling and responsive padding.
 * - Normal: 1rem mobile, 1.5rem desktop
 * - Compact: 0.75rem mobile, 1rem desktop
 */
export function Card({ children, compact, noPadding, className }: CardProps) {
  return (
    <div className={clsx(
      'glass-card',
      !noPadding && (compact ? 'card-padding-sm' : 'card-padding'),
      className
    )}>
      {children}
    </div>
  );
}

// ============================================================================
// Common Grid Patterns (convenience components)
// ============================================================================

interface StatsRowProps {
  children: ReactNode;
  /** Number of columns on desktop: 2, 3, or 4 */
  columns?: 2 | 3 | 4;
  className?: string;
}

/**
 * Row of stats cards - 2 columns on mobile, configurable on desktop.
 * Each child should be the card content (wrapper divs are added automatically).
 */
export function StatsRow({ children, columns = 4, className }: StatsRowProps) {
  const mdSpan = columns === 2 ? 6 : columns === 3 ? 4 : 3;
  
  return (
    <Grid12 className={className}>
      {Array.isArray(children) ? children.map((child, i) => (
        <GridCell key={i} span={6} md={mdSpan as ColSpan}>
          {child}
        </GridCell>
      )) : children}
    </Grid12>
  );
}

interface TwoColumnLayoutProps {
  /** Main content (left/top) - gets 8 columns on lg */
  main: ReactNode;
  /** Sidebar content (right/bottom) - gets 4 columns on lg */
  sidebar: ReactNode;
  className?: string;
}

/**
 * Two-column layout: 8/4 split on desktop, stacked on mobile.
 */
export function TwoColumnLayout({ main, sidebar, className }: TwoColumnLayoutProps) {
  return (
    <Grid12 className={className}>
      <GridCell span="full" lg={8}>{main}</GridCell>
      <GridCell span="full" lg={4}>{sidebar}</GridCell>
    </Grid12>
  );
}

interface ThreeColumnLayoutProps {
  children: ReactNode;
  className?: string;
}

/**
 * Three equal columns on lg, 2 on md, 1 on mobile.
 * Children should be 3 elements.
 */
export function ThreeColumnLayout({ children, className }: ThreeColumnLayoutProps) {
  return (
    <Grid12 className={className}>
      {Array.isArray(children) ? children.map((child, i) => (
        <GridCell key={i} span="full" md={6} lg={4}>
          {child}
        </GridCell>
      )) : children}
    </Grid12>
  );
}

// ============================================================================
// Export all components
// ============================================================================

export default {
  PageContainer,
  PageHeader,
  Grid12,
  GridCell,
  Card,
  StatsRow,
  TwoColumnLayout,
  ThreeColumnLayout,
};
