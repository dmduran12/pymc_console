'use client';

import { useState, memo, useMemo, useCallback, useRef } from 'react';
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
  size: number; // Recharts passes the dataKey value as 'size'
  index: number;
  colors: string[];
  depth: number;
  hoveredIndex: number | null;
  onHover: (index: number | null, event?: React.MouseEvent) => void;
  total: number;
}

/** Extract short tag from packet type name, e.g. "PLAIN TEXT MESSAGE (TXT_MSG)" -> "TXT_MSG" */
function getShortTag(name: string): string {
  // Match content in parentheses at end
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (match) return match[1];
  // Fallback: use the name as-is but truncate
  return name.length > 10 ? name.slice(0, 10) : name;
}

/** Custom content renderer for treemap cells */
function TreemapCell({
  x,
  y,
  width,
  height,
  name,
  size,
  index,
  colors,
  depth,
  hoveredIndex,
  onHover,
  total,
}: TreemapNodeProps) {
  // Only render leaf nodes (depth === 1)
  if (depth !== 1) return null;
  
  const isHovered = hoveredIndex === index;
  const isDimmed = hoveredIndex !== null && !isHovered;
  const color = colors[index % colors.length];
  
  // Calculate percentage from size and total
  const percent = total > 0 ? (size / total) * 100 : 0;
  
  // Responsive label display based on cell size
  const showTag = width > 36 && height > 20;
  const showPercent = width > 36 && height > 32;
  const padding = 4;
  const lineHeight = 11;
  
  const shortTag = getShortTag(name);
  
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
      {showTag && (
        <>
          {/* Percentage on second-to-last line */}
          {showPercent && (
            <text
              x={x + padding}
              y={y + height - padding - lineHeight}
              textAnchor="start"
              dominantBaseline="auto"
              fill="rgba(0,0,0,0.6)"
              fontSize={8}
              fontFamily="'JetBrains Mono', monospace"
              fontWeight={500}
              style={{ pointerEvents: 'none' }}
            >
              {percent.toFixed(1)}%
            </text>
          )}
          {/* Tag on last line */}
          <text
            x={x + padding}
            y={y + height - padding}
            textAnchor="start"
            dominantBaseline="auto"
            fill="rgba(0,0,0,0.85)"
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
            fontWeight={600}
            style={{ pointerEvents: 'none' }}
          >
            {shortTag}
          </text>
        </>
      )}
    </g>
  );
}

/** Tooltip component - positioned to stay within container bounds */
function TreemapTooltip({ 
  data, 
  total,
  color,
  position,
  containerWidth,
}: { 
  data: { name: string; value: number } | null;
  total: number;
  color: string;
  position: { x: number; y: number } | null;
  containerWidth: number;
}) {
  if (!data || !position) return null;
  
  const percent = ((data.value / total) * 100).toFixed(1);
  const tooltipWidth = 160; // approximate tooltip width
  
  // Position tooltip - flip to left side if too close to right edge
  const spaceOnRight = containerWidth - position.x;
  const showOnLeft = spaceOnRight < tooltipWidth + 24;
  
  const left = showOnLeft 
    ? Math.max(8, position.x - tooltipWidth - 8)
    : position.x + 16;
  
  return (
    <div 
      className="absolute z-50 pointer-events-none"
      style={{
        left,
        top: Math.max(8, position.y - 60),
      }}
    >
      <div className="bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 shadow-lg min-w-[140px]">
        <div className="flex items-center gap-2 mb-1">
          <span 
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0" 
            style={{ backgroundColor: color }}
          />
          <span className="type-data-sm font-semibold text-text-primary">
            {getShortTag(data.name)}
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
            <span>Total</span>
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
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
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
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        setContainerWidth(rect.width);
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
    <div className="h-56 relative treemap-container" ref={containerRef}>
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
              size={0}
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
        containerWidth={containerWidth}
      />
    </div>
  );
}

export const PacketTypesChart = memo(PacketTypesChartComponent);
