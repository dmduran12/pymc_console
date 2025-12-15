'use client';

import { useState, memo, useMemo, useCallback } from 'react';
import { Treemap, ResponsiveContainer } from 'recharts';
import { useChartColorArray } from '@/lib/hooks/useThemeColors';

interface PacketTypeData {
  name: string;
  value: number;
}

interface PacketTypesChartProps {
  data: PacketTypeData[];
}

interface TreemapNodeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  value: number;
  index: number;
  colors: string[];
  depth: number;
  hoveredIndex: number | null;
  onHover: (index: number | null, event?: React.MouseEvent) => void;
  total: number;
}

/** Custom content renderer for treemap cells */
function TreemapCell({
  x,
  y,
  width,
  height,
  name,
  index,
  colors,
  depth,
  hoveredIndex,
  onHover,
}: TreemapNodeProps) {
  // Only render leaf nodes (depth === 1)
  if (depth !== 1) return null;
  
  const isHovered = hoveredIndex === index;
  const isDimmed = hoveredIndex !== null && !isHovered;
  const color = colors[index % colors.length];
  
  // Only show label if cell is large enough
  const showLabel = width > 45 && height > 24;
  // Padding from bottom-left corner
  const padding = 6;
  
  return (
    <g
      onMouseEnter={(e) => onHover(index, e)}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: 'default' }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        opacity={isDimmed ? 0.4 : 1}
        stroke="rgba(0,0,0,0.2)"
        strokeWidth={1}
        rx={3}
        style={{ transition: 'opacity 150ms ease' }}
      />
      {showLabel && (
        <text
          x={x + padding}
          y={y + height - padding}
          textAnchor="start"
          dominantBaseline="auto"
          fill="rgba(0,0,0,0.85)"
          className="type-data-xs"
          style={{ 
            fontSize: 'var(--step--2)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            textTransform: 'uppercase',
            pointerEvents: 'none',
          }}
        >
          {name.toUpperCase()}
        </text>
      )}
    </g>
  );
}

/** Tooltip component positioned away from cursor */
function TreemapTooltip({ 
  data, 
  total,
  color,
  position,
}: { 
  data: { name: string; value: number } | null;
  total: number;
  color: string;
  position: { x: number; y: number } | null;
}) {
  if (!data || !position) return null;
  
  const percent = ((data.value / total) * 100).toFixed(1);
  
  return (
    <div 
      className="absolute z-50 pointer-events-none"
      style={{
        left: position.x + 16,
        top: position.y - 60,
      }}
    >
      <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2 mb-1">
          <span 
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0" 
            style={{ backgroundColor: color }}
          />
          <span className="type-data-sm font-semibold text-text-primary uppercase">
            {data.name.toUpperCase()}
          </span>
        </div>
        <div className="space-y-0.5 type-data-xs text-text-muted">
          <div className="flex justify-between gap-4">
            <span>Count</span>
            <span className="text-text-primary tabular-nums font-medium">
              {data.value.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Share</span>
            <span className="text-text-primary tabular-nums font-medium">
              {percent}%
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Of Total</span>
            <span className="text-text-primary tabular-nums font-medium">
              {total.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Treemap chart for packet type distribution
 * Features: hover highlighting, color-coded cells, theme-aware colors
 */
function PacketTypesChartComponent({ data }: PacketTypesChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const chartColors = useChartColorArray();

  const { treemapData, total } = useMemo(() => {
    const total = data.reduce((sum, e) => sum + e.value, 0);
    const sorted = [...data].sort((a, b) => b.value - a.value);
    // Filter out very small values (<0.5%)
    const filtered = sorted.filter((e) => total > 0 && (e.value / total) * 100 >= 0.5);
    // Format for Recharts Treemap
    const treemapData = filtered.map((item, index) => ({
      name: item.name,
      size: item.value,
      index,
    }));
    return { treemapData, total };
  }, [data]);

  const handleHover = useCallback((index: number | null, event?: React.MouseEvent) => {
    setHoveredIndex(index);
    if (event && index !== null) {
      const rect = (event.currentTarget as SVGElement).closest('.treemap-container')?.getBoundingClientRect();
      if (rect) {
        setMousePos({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
    } else {
      setMousePos(null);
    }
  }, []);

  // Get hovered data for tooltip
  const hoveredData = hoveredIndex !== null ? {
    name: treemapData[hoveredIndex]?.name ?? '',
    value: treemapData[hoveredIndex]?.size ?? 0,
  } : null;
  const hoveredColor = hoveredIndex !== null ? chartColors[hoveredIndex % chartColors.length] : '';

  if (data.length === 0 || total === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-text-muted">
        No packet type data available
      </div>
    );
  }

  return (
    <div className="h-56 relative treemap-container">
      <ResponsiveContainer width="100%" height="100%">
        <Treemap
          data={treemapData}
          dataKey="size"
          aspectRatio={4 / 3}
          stroke="none"
          isAnimationActive={false}
          content={(
            <TreemapCell
              x={0}
              y={0}
              width={0}
              height={0}
              name=""
              value={0}
              index={0}
              colors={chartColors}
              depth={0}
              hoveredIndex={hoveredIndex}
              onHover={handleHover}
              total={total}
            />
          )}
        />
      </ResponsiveContainer>
      <TreemapTooltip 
        data={hoveredData}
        total={total}
        color={hoveredColor}
        position={mousePos}
      />
    </div>
  );
}

export const PacketTypesChart = memo(PacketTypesChartComponent);
