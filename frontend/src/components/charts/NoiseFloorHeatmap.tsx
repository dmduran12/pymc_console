'use client';

import { useMemo, memo } from 'react';
import { useChartColors } from '@/lib/hooks/useThemeColors';

interface NoiseFloorHeatmapProps {
  timestamps: number[];
  values: number[];
  height?: number;
}

/**
 * Noise Floor Heatmap - High frequency scatter with heat density
 * Uses square pixels with color intensity based on density around the trend
 */
function NoiseFloorHeatmapComponent({ timestamps, values, height = 224 }: NoiseFloorHeatmapProps) {
  const chartColors = useChartColors();
  
  const { cells, stats, xLabels, yLabels } = useMemo(() => {
    if (timestamps.length === 0 || values.length === 0) {
      return { cells: [], stats: null, xLabels: [], yLabels: [] };
    }

    // Grid dimensions - more columns for higher time resolution
    const cols = Math.min(120, timestamps.length);
    const rows = 40;

    // Calculate value range with padding
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;
    const padding = range * 0.1;
    const yMin = minVal - padding;
    const yMax = maxVal + padding;
    const yRange = yMax - yMin;

    // Time range
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const timeRange = maxTime - minTime || 1;

    // Create density grid
    const grid: number[][] = Array(rows).fill(null).map(() => Array(cols).fill(0));
    
    // Plot each point into the grid
    for (let i = 0; i < timestamps.length; i++) {
      const x = Math.floor(((timestamps[i] - minTime) / timeRange) * (cols - 1));
      const y = Math.floor(((values[i] - yMin) / yRange) * (rows - 1));
      
      // Clamp to grid bounds
      const cx = Math.max(0, Math.min(cols - 1, x));
      const cy = Math.max(0, Math.min(rows - 1, rows - 1 - y)); // Flip Y axis
      
      grid[cy][cx]++;
      
      // Add some blur/spread for heat effect
      if (cy > 0) grid[cy - 1][cx] += 0.3;
      if (cy < rows - 1) grid[cy + 1][cx] += 0.3;
      if (cx > 0) grid[cy][cx - 1] += 0.2;
      if (cx < cols - 1) grid[cy][cx + 1] += 0.2;
    }

    // Find max density for normalization
    let maxDensity = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c] > maxDensity) maxDensity = grid[r][c];
      }
    }

    // Convert grid to cell array with normalized intensity
    const cells: { x: number; y: number; intensity: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c] > 0) {
          cells.push({
            x: c,
            y: r,
            intensity: grid[r][c] / maxDensity,
          });
        }
      }
    }

    // Generate axis labels
    const xLabels: { pos: number; label: string }[] = [];
    const labelCount = 5;
    for (let i = 0; i <= labelCount; i++) {
      const t = minTime + (timeRange * i) / labelCount;
      xLabels.push({
        pos: (i / labelCount) * 100,
        label: new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    }

    const yLabels: { pos: number; label: string }[] = [];
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yRange * i) / 4;
      yLabels.push({
        pos: (1 - i / 4) * 100,
        label: `${Math.round(v)}`,
      });
    }

    return {
      cells,
      stats: {
        min: minVal,
        max: maxVal,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        cols,
        rows,
      },
      xLabels,
      yLabels,
    };
  }, [timestamps, values]);

  if (!stats || cells.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-text-muted">
        No noise floor data available
      </div>
    );
  }

  // Calculate cell dimensions
  const cellWidth = 100 / stats.cols;
  const cellHeight = 100 / stats.rows;

  // Get primary chart color for the heatmap
  const baseColor = chartColors.chart1;

  return (
    <div className="relative" style={{ height }}>
      {/* Y-axis labels */}
      <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-right pr-2">
        {yLabels.map((label, i) => (
          <span
            key={i}
            className="type-data-xs text-text-muted tabular-nums"
            style={{ position: 'absolute', top: `${label.pos}%`, transform: 'translateY(-50%)' }}
          >
            {label.label}
          </span>
        ))}
      </div>

      {/* Chart area */}
      <div className="absolute left-10 right-0 top-0 bottom-6">
        {/* Grid background */}
        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          {/* Horizontal grid lines */}
          {[0, 25, 50, 75, 100].map((y) => (
            <line
              key={y}
              x1="0"
              y1={`${y}%`}
              x2="100%"
              y2={`${y}%`}
              stroke="rgba(255,255,255,0.06)"
              strokeDasharray="3 3"
            />
          ))}
        </svg>

        {/* Heatmap cells */}
        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          {cells.map((cell, i) => {
            // Intensity-based opacity and color
            const opacity = 0.15 + cell.intensity * 0.85;
            const saturation = 50 + cell.intensity * 50;
            
            return (
              <rect
                key={i}
                x={`${cell.x * cellWidth}%`}
                y={`${cell.y * cellHeight}%`}
                width={`${cellWidth + 0.1}%`}
                height={`${cellHeight + 0.1}%`}
                fill={baseColor}
                opacity={opacity}
                style={{
                  filter: cell.intensity > 0.7 ? `saturate(${saturation}%)` : undefined,
                }}
              />
            );
          })}
        </svg>

        {/* Stats overlay */}
        <div className="absolute top-2 right-2 flex gap-3">
          <span className="type-data-xs text-text-muted">
            min <span className="text-text-secondary tabular-nums">{stats.min.toFixed(0)}</span>
          </span>
          <span className="type-data-xs text-text-muted">
            avg <span className="text-text-secondary tabular-nums">{stats.avg.toFixed(0)}</span>
          </span>
          <span className="type-data-xs text-text-muted">
            max <span className="text-text-secondary tabular-nums">{stats.max.toFixed(0)}</span>
          </span>
        </div>
      </div>

      {/* X-axis labels */}
      <div className="absolute left-10 right-0 bottom-0 h-6 flex justify-between">
        {xLabels.map((label, i) => (
          <span
            key={i}
            className="type-data-xs text-text-muted tabular-nums"
            style={{ position: 'absolute', left: `${label.pos}%`, transform: 'translateX(-50%)' }}
          >
            {label.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export const NoiseFloorHeatmap = memo(NoiseFloorHeatmapComponent);
