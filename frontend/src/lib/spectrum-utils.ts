/**
 * Spectrum Analyzer Utilities
 * 
 * Converts fixed-window W samples into pixel-column aggregates for
 * canvas-based spectrum analyzer visualization.
 * 
 * Key insight: downsample to chart width in pixels (not MAX_POINTS),
 * so spikes remain visible regardless of time range.
 */

import type { BucketData } from '@/lib/api';

// ============================================================================
// Types
// ============================================================================

/**
 * Fixed-window utilization sample.
 * util% = airtime_ms / W_ms * 100
 */
export interface UtilSample {
  timestamp: number;  // seconds epoch
  rxUtilW: number;    // % over window W
  txUtilW: number;    // % over window W
}

/**
 * Aggregated data for a single pixel column.
 * Contains both peak (for spikes) and avg (for trend).
 */
export interface ColumnAgg {
  rxMax: number;   // max spike in this column
  txMax: number;
  rxHits: number;  // non-zero samples (density)
  txHits: number;
  rxAvg: number;   // average (for trend overlay)
  txAvg: number;
}

// ============================================================================
// Data Processing
// ============================================================================

/**
 * Combine transmitted and forwarded buckets by timestamp.
 * Handles both aligned and unaligned timestamps.
 */
export function combineTxBuckets(
  transmitted: BucketData[], 
  forwarded: BucketData[]
): BucketData[] {
  const byTs = new Map<number, BucketData>();

  for (const b of transmitted) {
    byTs.set(b.start, { ...b });
  }
  
  for (const b of forwarded) {
    const prev = byTs.get(b.start);
    if (prev) {
      prev.airtime_ms += b.airtime_ms;
      prev.count += b.count;
    } else {
      byTs.set(b.start, { ...b });
    }
  }

  return Array.from(byTs.values()).sort((a, b) => a.start - b.start);
}

/**
 * Convert raw BucketData arrays to UtilSample array.
 * 
 * @param rx - Received buckets
 * @param tx - Combined TX buckets (transmitted + forwarded)
 * @param windowMs - Fixed window W in milliseconds
 */
export function toUtilSamples(
  rx: BucketData[],
  tx: BucketData[],
  windowMs: number
): UtilSample[] {
  // Build maps for O(1) lookup
  const rxMap = new Map(rx.map(b => [b.start, b]));
  const txMap = new Map(tx.map(b => [b.start, b]));

  // Merge all timestamps (missing = 0 util, which is valid idle)
  const allTs = Array.from(new Set([...rxMap.keys(), ...txMap.keys()])).sort((a, b) => a - b);

  return allTs.map(ts => {
    const r = rxMap.get(ts);
    const t = txMap.get(ts);
    const rxUtilW = ((r?.airtime_ms ?? 0) / windowMs) * 100;
    const txUtilW = ((t?.airtime_ms ?? 0) / windowMs) * 100;
    return { timestamp: ts, rxUtilW, txUtilW };
  });
}

/**
 * Aggregate samples to pixel columns.
 * 
 * This is the secret sauce: downsample to chart width in pixels,
 * so spikes remain visible regardless of zoom level.
 * 
 * @param samples - Fixed-window util samples
 * @param startTs - Range start (seconds)
 * @param endTs - Range end (seconds)
 * @param xBins - Number of pixel columns (chart width)
 */
export function aggregateToColumns(
  samples: UtilSample[],
  startTs: number,
  endTs: number,
  xBins: number
): ColumnAgg[] {
  const cols: ColumnAgg[] = Array.from({ length: xBins }, () => ({
    rxMax: 0, txMax: 0,
    rxHits: 0, txHits: 0,
    rxAvg: 0, txAvg: 0,
  }));

  const range = endTs - startTs;
  if (range <= 0 || xBins <= 0) return cols;

  // Track sums for averaging
  const rxSum = new Float64Array(xBins);
  const txSum = new Float64Array(xBins);
  const n = new Uint32Array(xBins);

  for (const s of samples) {
    if (s.timestamp < startTs || s.timestamp > endTs) continue;
    
    const x = Math.min(
      xBins - 1, 
      Math.max(0, Math.floor(((s.timestamp - startTs) / range) * xBins))
    );

    n[x]++;
    rxSum[x] += s.rxUtilW;
    txSum[x] += s.txUtilW;

    if (s.rxUtilW > cols[x].rxMax) cols[x].rxMax = s.rxUtilW;
    if (s.txUtilW > cols[x].txMax) cols[x].txMax = s.txUtilW;

    if (s.rxUtilW > 0) cols[x].rxHits++;
    if (s.txUtilW > 0) cols[x].txHits++;
  }

  // Compute averages
  for (let i = 0; i < xBins; i++) {
    const denom = n[i] || 1;
    cols[i].rxAvg = rxSum[i] / denom;
    cols[i].txAvg = txSum[i] / denom;
  }

  return cols;
}

// ============================================================================
// Canvas Drawing
// ============================================================================

export interface DrawSpectrumOptions {
  yMax: number;        // Max Y value (e.g., 30%)
  ledSteps?: number;   // Number of LED segments (default 24)
  ledGap?: number;     // Gap between LEDs in pixels (default 1)
}

const RX_COLOR = { r: 57, g: 217, b: 138 };   // #39D98A green
const TX_COLOR = { r: 176, g: 176, b: 195 };  // #B0B0C3 gray

/**
 * Draw LED-style spectrum analyzer visualization on canvas.
 * 
 * Each x-pixel column draws vertical LED bars from baseline up to the peak (max util over W).
 * LEDs are quantized into discrete segments with small gaps for classic analyzer look.
 * 
 * Visual hierarchy:
 * - Peak LED: brightest (alpha 0.9)
 * - Upper LEDs: high alpha with slight fade toward bottom
 * - Creates vertical columns that "pop" at a distance
 */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  cols: ColumnAgg[],
  width: number,
  height: number,
  options: DrawSpectrumOptions
): void {
  const { yMax, ledSteps = 24, ledGap = 1 } = options;
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height);
  
  // Reserve space for axis labels (match Recharts YAxis)
  const leftMargin = 44;
  const rightMargin = 8;
  const topMargin = 8;
  const bottomMargin = 40; // space for X axis labels
  
  const chartWidth = width - leftMargin - rightMargin;
  const chartHeight = height - topMargin - bottomMargin;
  
  if (chartWidth <= 0 || chartHeight <= 0) return;
  
  // Column width: 2px for visibility, or 1px if many columns
  const idealColWidth = cols.length > chartWidth / 2 ? 1 : 2;
  const colWidth = Math.max(1, Math.min(idealColWidth, chartWidth / cols.length));
  
  // LED dimensions
  const totalLedHeight = chartHeight / ledSteps;
  const ledHeight = Math.max(1, totalLedHeight - ledGap);
  
  // Baseline Y (bottom of chart area)
  const baseY = topMargin + chartHeight;
  
  /**
   * Draw LED column from baseline up to the peak value.
   * Uses quantized LED steps with gaps for classic analyzer look.
   */
  const drawLedColumn = (
    x: number,
    peakUtil: number,
    color: { r: number; g: number; b: number },
    peakAlpha: number,
    baseAlpha: number
  ): void => {
    if (peakUtil <= 0) return;
    
    // How many LED segments to light up (0 to ledSteps)
    const normalizedPeak = Math.min(peakUtil / yMax, 1);
    const litLeds = Math.ceil(normalizedPeak * ledSteps);
    
    if (litLeds === 0) return;
    
    // Draw LEDs from bottom to top
    for (let led = 0; led < litLeds; led++) {
      // Y position: bottom-up
      const y = baseY - (led + 1) * totalLedHeight + ledGap;
      
      // Alpha gradient: base alpha at bottom, peak alpha at top
      // Creates visual emphasis on the peak
      const t = led / Math.max(1, litLeds - 1); // 0 at bottom, 1 at top
      const alpha = baseAlpha + t * (peakAlpha - baseAlpha);
      
      ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
      ctx.fillRect(x, y, colWidth, ledHeight);
    }
  };
  
  // Draw each column
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const x = leftMargin + i * colWidth;
    
    // Skip if x is beyond chart width
    if (x > leftMargin + chartWidth) break;
    
    // Draw TX first (behind RX) - lower alpha, more subtle
    drawLedColumn(x, col.txMax, TX_COLOR, 0.65, 0.25);
    
    // Draw RX on top - higher alpha, more prominent
    drawLedColumn(x, col.rxMax, RX_COLOR, 0.90, 0.35);
  }
}

/**
 * Draw full spectrogram grid (Y-binned intensity).
 * 
 * Alternative to peak-only display - shows full distribution
 * of utilization values as a heatmap.
 * 
 * @param yBins - Number of Y bins (e.g., 120 for 0.25% per row at 30% max)
 */
export function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  cols: ColumnAgg[],
  samples: UtilSample[],
  startTs: number,
  endTs: number,
  width: number,
  height: number,
  options: { yMax: number; yBins: number }
): void {
  const { yMax, yBins } = options;
  
  ctx.clearRect(0, 0, width, height);
  
  const leftMargin = 44;
  const rightMargin = 8;
  const topMargin = 8;
  const bottomMargin = 40;
  
  const chartWidth = width - leftMargin - rightMargin;
  const chartHeight = height - topMargin - bottomMargin;
  
  if (chartWidth <= 0 || chartHeight <= 0) return;
  
  const xBins = cols.length;
  const range = endTs - startTs;
  if (range <= 0) return;
  
  // Build intensity grid
  const rxGrid = new Uint16Array(xBins * yBins);
  const txGrid = new Uint16Array(xBins * yBins);
  
  for (const s of samples) {
    if (s.timestamp < startTs || s.timestamp > endTs) continue;
    
    const x = Math.min(xBins - 1, Math.max(0, Math.floor(((s.timestamp - startTs) / range) * xBins)));
    
    // Map util to Y bin
    const rxY = Math.min(yBins - 1, Math.max(0, Math.floor((s.rxUtilW / yMax) * yBins)));
    const txY = Math.min(yBins - 1, Math.max(0, Math.floor((s.txUtilW / yMax) * yBins)));
    
    rxGrid[x * yBins + rxY]++;
    txGrid[x * yBins + txY]++;
  }
  
  // Find max for normalization
  let rxMaxCount = 1, txMaxCount = 1;
  for (let i = 0; i < rxGrid.length; i++) {
    if (rxGrid[i] > rxMaxCount) rxMaxCount = rxGrid[i];
    if (txGrid[i] > txMaxCount) txMaxCount = txGrid[i];
  }
  
  // Draw cells
  const cellWidth = chartWidth / xBins;
  const cellHeight = chartHeight / yBins;
  
  for (let xi = 0; xi < xBins; xi++) {
    for (let yi = 0; yi < yBins; yi++) {
      const idx = xi * yBins + yi;
      const x = leftMargin + xi * cellWidth;
      const y = topMargin + chartHeight - (yi + 1) * cellHeight; // flip Y
      
      // Draw TX (behind)
      const txIntensity = txGrid[idx] / txMaxCount;
      if (txIntensity > 0) {
        ctx.fillStyle = `rgba(${TX_COLOR.r}, ${TX_COLOR.g}, ${TX_COLOR.b}, ${txIntensity * 0.5})`;
        ctx.fillRect(x, y, cellWidth, cellHeight);
      }
      
      // Draw RX (on top)
      const rxIntensity = rxGrid[idx] / rxMaxCount;
      if (rxIntensity > 0) {
        ctx.fillStyle = `rgba(${RX_COLOR.r}, ${RX_COLOR.g}, ${RX_COLOR.b}, ${rxIntensity * 0.6})`;
        ctx.fillRect(x, y, cellWidth, cellHeight);
      }
    }
  }
}
