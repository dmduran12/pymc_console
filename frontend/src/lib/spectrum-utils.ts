/**
 * Spectrum Analyzer Utilities
 * 
 * True spectrogram visualization with:
 * - 2D intensity field (X = time, Y = utilization %)
 * - Bilinear splatting for smooth energy distribution
 * - Separable box blur for "alive" appearance
 * - Log/gamma compression to handle dynamic range
 * - Inferno-ish colormap (black → purple → orange → yellow → white)
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
// Spectrogram Grid Building
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build a 2D spectrogram grid from fixed-window utilization samples.
 * 
 * Each sample places energy at its (time, util%) position using bilinear
 * splatting. Horizontal blur creates the "persistence" effect.
 * 
 * @param samples - Fixed-window util samples
 * @param startTs - Range start (seconds)
 * @param endTs - Range end (seconds)
 * @param width - Grid width (pixels)
 * @param height - Grid height (pixels)
 * @param yMax - Max Y value (e.g., 30%)
 * @param mode - Which utilization to use: rx, tx, max, or sum
 */
export function buildSpectrogramGrid(
  samples: UtilSample[],
  startTs: number,
  endTs: number,
  width: number,
  height: number,
  yMax: number,
  mode: 'rx' | 'tx' | 'max' | 'sum' = 'max'
): Float32Array {
  const grid = new Float32Array(width * height);
  const range = endTs - startTs;
  if (range <= 0 || width <= 0 || height <= 0) return grid;

  for (const s of samples) {
    if (s.timestamp < startTs || s.timestamp > endTs) continue;

    const util =
      mode === 'rx' ? s.rxUtilW :
      mode === 'tx' ? s.txUtilW :
      mode === 'sum' ? (s.rxUtilW + s.txUtilW) :
      Math.max(s.rxUtilW, s.txUtilW);

    if (util <= 0) continue;

    const u = clamp(util, 0, yMax);

    // X position with sub-pixel interpolation
    const xf = ((s.timestamp - startTs) / range) * (width - 1);
    const x0 = Math.floor(xf);
    const x1 = Math.min(width - 1, x0 + 1);
    const tx = xf - x0;

    // Y position: y=0 is top (yMax%), y=height-1 is bottom (0%)
    const yf = (1 - (u / yMax)) * (height - 1);
    const y0 = Math.floor(yf);
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = yf - y0;

    // Energy weighted by utilization for intensity
    const energy = Math.sqrt(u / yMax); // sqrt to boost low values visibility

    // Bilinear splat - places energy at the exact position
    grid[y0 * width + x0] += energy * (1 - tx) * (1 - ty);
    grid[y0 * width + x1] += energy * tx * (1 - ty);
    grid[y1 * width + x0] += energy * (1 - tx) * ty;
    grid[y1 * width + x1] += energy * tx * ty;
  }

  return grid;
}

// ============================================================================
// Blur (Separable Box Blur)
// ============================================================================

/**
 * Fast separable box blur: horizontal + vertical passes.
 * This is what makes the spectrogram look "alive" and continuous.
 */
export function boxBlur2D(
  grid: Float32Array,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number
): Float32Array {
  const tmp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);

  // Horizontal blur per row
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const winX = radiusX * 2 + 1;
    let sum = 0;
    
    // Initial window
    for (let k = -radiusX; k <= radiusX; k++) {
      sum += grid[rowOffset + clamp(k, 0, width - 1)];
    }
    tmp[rowOffset] = sum / winX;
    
    // Slide window
    for (let x = 1; x < width; x++) {
      const outIdx = clamp(x - radiusX - 1, 0, width - 1);
      const inIdx = clamp(x + radiusX, 0, width - 1);
      sum += grid[rowOffset + inIdx] - grid[rowOffset + outIdx];
      tmp[rowOffset + x] = sum / winX;
    }
  }

  // Vertical blur per column
  for (let x = 0; x < width; x++) {
    const winY = radiusY * 2 + 1;
    let sum = 0;
    
    // Initial window
    for (let k = -radiusY; k <= radiusY; k++) {
      sum += tmp[clamp(k, 0, height - 1) * width + x];
    }
    out[x] = sum / winY;
    
    // Slide window
    for (let y = 1; y < height; y++) {
      const outIdx = clamp(y - radiusY - 1, 0, height - 1);
      const inIdx = clamp(y + radiusY, 0, height - 1);
      sum += tmp[inIdx * width + x] - tmp[outIdx * width + x];
      out[y * width + x] = sum / winY;
    }
  }

  return out;
}

// ============================================================================
// Colormap (Inferno-ish)
// ============================================================================

interface ColorStop {
  t: number;
  r: number;
  g: number;
  b: number;
}

// Inferno-inspired gradient: deep purple → magenta → orange → yellow → white
// Note: Alpha handled separately - colormap is just RGB
const INFERNO_STOPS: ColorStop[] = [
  { t: 0.00, r:  40, g:   0, b:  80 },  // Deep purple (at threshold)
  { t: 0.25, r: 120, g:  30, b: 140 },  // Purple-magenta
  { t: 0.50, r: 200, g:  60, b:  80 },  // Magenta-red
  { t: 0.70, r: 230, g:  90, b:  40 },  // Orange
  { t: 0.88, r: 255, g: 190, b:  60 },  // Yellow
  { t: 1.00, r: 255, g: 255, b: 255 },  // White
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorInferno(t: number): { r: number; g: number; b: number } {
  t = clamp(t, 0, 1);
  for (let i = 0; i < INFERNO_STOPS.length - 1; i++) {
    const a = INFERNO_STOPS[i];
    const b = INFERNO_STOPS[i + 1];
    if (t >= a.t && t <= b.t) {
      const u = (t - a.t) / (b.t - a.t || 1);
      return {
        r: Math.round(lerp(a.r, b.r, u)),
        g: Math.round(lerp(a.g, b.g, u)),
        b: Math.round(lerp(a.b, b.b, u)),
      };
    }
  }
  return { r: 255, g: 255, b: 255 };
}

// ============================================================================
// Spectrogram Rendering
// ============================================================================

export interface SpectrogramOptions {
  yMax: number;       // Max Y value (e.g., 30%)
  gain?: number;      // Contrast boost for low energy (default 6)
  gamma?: number;     // <1 brightens mids (default 0.65)
  floor?: number;     // Small floor for glow (default 0)
  blurX?: number;     // Horizontal blur radius (default 4)
  blurY?: number;     // Vertical blur radius (default 2)
  dpr?: number;       // Device pixel ratio (default 1)
}

/**
 * Draw true spectrogram visualization on canvas.
 * 
 * Pipeline:
 * 1. Build 2D density grid from samples (bilinear splat)
 * 2. Apply separable box blur
 * 3. Log/gamma compress for dynamic range
 * 4. Apply inferno colormap
 */
export function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  samples: UtilSample[],
  startTs: number,
  endTs: number,
  width: number,
  height: number,
  options: SpectrogramOptions
): void {
  const {
    yMax,
    gain = 6,
    gamma = 0.65,
    floor = 0,
    blurX = 4,
    blurY = 2,
    dpr = 1,
  } = options;

  // Scale everything by DPR for crisp rendering on high-DPI displays
  const scaledWidth = Math.floor(width * dpr);
  const scaledHeight = Math.floor(height * dpr);

  ctx.clearRect(0, 0, scaledWidth, scaledHeight);

  // Match Recharts chart area margins (empirically determined)
  // Recharts LineChart with YAxis width=44, Legend, and default padding
  const leftMargin = Math.floor(52 * dpr);   // YAxis width + internal padding
  const rightMargin = Math.floor(5 * dpr);   // Right edge padding
  const topMargin = Math.floor(5 * dpr);     // Top edge padding  
  const bottomMargin = Math.floor(50 * dpr); // XAxis + Legend height

  const chartWidth = scaledWidth - leftMargin - rightMargin;
  const chartHeight = scaledHeight - topMargin - bottomMargin;

  if (chartWidth <= 0 || chartHeight <= 0 || samples.length === 0) return;

  // Step 1: Build density grid with bilinear splatting (at full DPR resolution)
  const baseGrid = buildSpectrogramGrid(
    samples,
    startTs,
    endTs,
    chartWidth,
    chartHeight,
    yMax,
    'max'
  );

  // Step 2: Apply box blur for smooth, "alive" appearance
  // Scale blur radii by DPR to maintain visual appearance
  const scaledBlurX = Math.max(1, Math.floor(blurX * dpr));
  const scaledBlurY = Math.max(1, Math.floor(blurY * dpr));
  const blurredGrid = boxBlur2D(baseGrid, chartWidth, chartHeight, scaledBlurX, scaledBlurY);

  // Step 3: Find robust max (p99) so outliers don't crush everything
  const values = Array.from(blurredGrid).filter(v => v > 0);
  values.sort((a, b) => a - b);
  const p99 = values[Math.floor(values.length * 0.99)] || 1;

  // Step 4: Create image with log compression and inferno colormap
  // Use alpha channel for intensity - fully transparent where no energy
  const img = ctx.createImageData(chartWidth, chartHeight);
  const data = img.data;

  // Soft threshold with smooth falloff
  const softThreshold = 0.003;  // Below this = transparent
  const fadeZone = 0.02;        // Fade from softThreshold to softThreshold + fadeZone

  for (let i = 0; i < blurredGrid.length; i++) {
    const raw = blurredGrid[i] / p99;
    
    // Below soft threshold = fully transparent
    if (raw < softThreshold) {
      const o = i * 4;
      data[o + 0] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
      continue;
    }

    // Smooth fade-in for values in the fade zone
    let alphaMultiplier = 1.0;
    if (raw < softThreshold + fadeZone) {
      // Smooth cubic ease-in from 0 to 1
      const fadeT = (raw - softThreshold) / fadeZone;
      alphaMultiplier = fadeT * fadeT * (3 - 2 * fadeT); // smoothstep
    }

    // Map to color (log compression)
    const normalized = raw; // Use full range for color mapping
    const v = Math.log1p(gain * (normalized + floor)) / Math.log1p(gain * 1);
    const t = Math.pow(clamp(v, 0, 1), gamma);

    const { r, g, b } = colorInferno(t);
    const o = i * 4;
    data[o + 0] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    // Alpha: base 0.7, ramps to 1.0, with smooth fade-in near threshold
    const baseAlpha = 0.7 + 0.3 * t;
    data[o + 3] = Math.round(255 * baseAlpha * alphaMultiplier);
  }

  // Draw the spectrogram image directly at native resolution
  // (canvas is already sized at width*dpr x height*dpr)
  ctx.putImageData(img, leftMargin, topMargin);
}
