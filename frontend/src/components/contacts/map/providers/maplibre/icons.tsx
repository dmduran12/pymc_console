/**
 * MapLibre Icon System
 * 
 * HTML marker factories for all node types.
 * Direct port from Leaflet DivIcon system - maintains exact visual parity.
 * 
 * Differences from Leaflet version:
 * - Returns HTMLDivElement instead of L.DivIcon
 * - No iconAnchor/popupAnchor (handled by Marker offset prop)
 * - Caching still applies for DOM element reuse
 */

import { Home, MessagesSquare } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MARKER_SIZE,
  RING_THICKNESS,
  NEIGHBOR_OUTER_RING_SIZE,
  NEIGHBOR_RING_THICKNESS,
  ICON_CACHE_MAX_SIZE,
  DESIGN,
} from '../../constants';

// ═══════════════════════════════════════════════════════════════════════════════
// Icon Cache
// ═══════════════════════════════════════════════════════════════════════════════
// Cache HTML strings by parameter signature for efficient reuse.
// MapLibre Marker will create actual DOM elements from these.

const iconHtmlCache = new Map<string, string>();

/**
 * Get a cached icon HTML or create and cache a new one.
 * @param cacheKey - Unique key for this icon configuration
 * @param createFn - Factory function to create the HTML if not cached
 */
function getCachedIconHtml(cacheKey: string, createFn: () => string): string {
  const cached = iconHtmlCache.get(cacheKey);
  if (cached) return cached;
  
  // Evict oldest entries if cache is full (simple FIFO eviction)
  if (iconHtmlCache.size >= ICON_CACHE_MAX_SIZE) {
    const firstKey = iconHtmlCache.keys().next().value;
    if (firstKey) iconHtmlCache.delete(firstKey);
  }
  
  const html = createFn();
  iconHtmlCache.set(cacheKey, html);
  return html;
}

/** Clear the icon cache (useful for testing or theme changes) */
export function clearIconCache(): void {
  iconHtmlCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pre-rendered SVG Icons
// ═══════════════════════════════════════════════════════════════════════════════
// Render React icons to static markup once (expensive React render).

const HOME_ICON_SVG = renderToStaticMarkup(
  <Home size={MARKER_SIZE + 2} color={DESIGN.localColor} strokeWidth={2.5} fill="none" />
);

const ROOM_SERVER_ICON_SVG = renderToStaticMarkup(
  <MessagesSquare size={MARKER_SIZE + 2} color={DESIGN.roomServerColor} strokeWidth={2.5} fill="none" />
);

// ═══════════════════════════════════════════════════════════════════════════════
// Icon Dimension Exports (for Marker offset calculation)
// ═══════════════════════════════════════════════════════════════════════════════

export { MARKER_SIZE, NEIGHBOR_OUTER_RING_SIZE };

// ═══════════════════════════════════════════════════════════════════════════════
// Icon HTML Factories
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create ring (torus) icon HTML for standard nodes.
 * Thick ring with small donut hole - no stroke, just the ring itself.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param color - Ring color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createRingIconHtml(
  color: string = DESIGN.nodeColor,
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): string {
  const cacheKey = `ring:${color}:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIconHtml(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the main marker
    if (isNeighbor) {
      const offset = (NEIGHBOR_OUTER_RING_SIZE - MARKER_SIZE) / 2;
      return `<div style="
        position: relative;
        width: ${NEIGHBOR_OUTER_RING_SIZE}px;
        height: ${NEIGHBOR_OUTER_RING_SIZE}px;
        opacity: ${opacity};
        filter: brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      ">
        <!-- Yellow outer ring -->
        <div style="
          position: absolute;
          top: 0;
          left: 0;
          width: ${NEIGHBOR_OUTER_RING_SIZE}px;
          height: ${NEIGHBOR_OUTER_RING_SIZE}px;
          background: transparent;
          border-radius: 50%;
          border: ${NEIGHBOR_RING_THICKNESS}px solid ${DESIGN.neighborColor};
          box-sizing: border-box;
          opacity: 0.7;
        "></div>
        <!-- Inner colored ring -->
        <div style="
          position: absolute;
          top: ${offset}px;
          left: ${offset}px;
          width: ${MARKER_SIZE}px;
          height: ${MARKER_SIZE}px;
          background: transparent;
          border-radius: 50%;
          border: ${RING_THICKNESS}px solid ${color};
          box-sizing: border-box;
        "></div>
      </div>`;
    }
    
    return `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background: transparent;
      border-radius: 50%;
      border: ${RING_THICKNESS}px solid ${color};
      box-sizing: border-box;
      opacity: ${opacity};
      filter: brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    "></div>`;
  });
}

/**
 * Create filled dot icon HTML for hub nodes.
 * Same outer dimension as ring - no border/stroke.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param color - Fill color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createFilledIconHtml(
  color: string = DESIGN.hubColor,
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): string {
  const cacheKey = `filled:${color}:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIconHtml(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the hub marker
    if (isNeighbor) {
      const offset = (NEIGHBOR_OUTER_RING_SIZE - MARKER_SIZE) / 2;
      return `<div style="
        position: relative;
        width: ${NEIGHBOR_OUTER_RING_SIZE}px;
        height: ${NEIGHBOR_OUTER_RING_SIZE}px;
        opacity: ${opacity};
        filter: brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      ">
        <!-- Yellow outer ring -->
        <div style="
          position: absolute;
          top: 0;
          left: 0;
          width: ${NEIGHBOR_OUTER_RING_SIZE}px;
          height: ${NEIGHBOR_OUTER_RING_SIZE}px;
          background: transparent;
          border-radius: 50%;
          border: ${NEIGHBOR_RING_THICKNESS}px solid ${DESIGN.neighborColor};
          box-sizing: border-box;
          opacity: 0.7;
        "></div>
        <!-- Inner filled dot -->
        <div style="
          position: absolute;
          top: ${offset}px;
          left: ${offset}px;
          width: ${MARKER_SIZE}px;
          height: ${MARKER_SIZE}px;
          background-color: ${color};
          border-radius: 50%;
          box-sizing: border-box;
        "></div>
      </div>`;
    }
    
    return `<div style="
      width: ${MARKER_SIZE}px;
      height: ${MARKER_SIZE}px;
      background-color: ${color};
      border-radius: 50%;
      box-sizing: border-box;
      opacity: ${opacity};
      filter: brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    "></div>`;
  });
}

/**
 * Create local node icon HTML - yellow house icon to indicate "home" node.
 * Uses lucide-react Home icon rendered as static SVG.
 * 
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
export function createLocalIconHtml(isHovered: boolean = false): string {
  const cacheKey = `local:${isHovered}`;
  
  return getCachedIconHtml(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    return `<div style="
      width: ${MARKER_SIZE + 2}px;
      height: ${MARKER_SIZE + 2}px;
      display: flex;
      align-items: center;
      justify-content: center;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    ">${HOME_ICON_SVG}</div>`;
  });
}

/**
 * Create room server icon HTML - amber chat bubble icon.
 * Uses lucide-react MessagesSquare icon rendered as static SVG.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createRoomServerIconHtml(
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): string {
  const cacheKey = `roomserver:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIconHtml(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the icon
    if (isNeighbor) {
      const iconSize = MARKER_SIZE + 2;
      const offset = (NEIGHBOR_OUTER_RING_SIZE - iconSize) / 2;
      return `<div style="
        position: relative;
        width: ${NEIGHBOR_OUTER_RING_SIZE}px;
        height: ${NEIGHBOR_OUTER_RING_SIZE}px;
        opacity: ${opacity};
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      ">
        <!-- Yellow outer ring -->
        <div style="
          position: absolute;
          top: 0;
          left: 0;
          width: ${NEIGHBOR_OUTER_RING_SIZE}px;
          height: ${NEIGHBOR_OUTER_RING_SIZE}px;
          background: transparent;
          border-radius: 50%;
          border: ${NEIGHBOR_RING_THICKNESS}px solid ${DESIGN.neighborColor};
          box-sizing: border-box;
          opacity: 0.7;
        "></div>
        <!-- Icon -->
        <div style="
          position: absolute;
          top: ${offset}px;
          left: ${offset}px;
          width: ${iconSize}px;
          height: ${iconSize}px;
          display: flex;
          align-items: center;
          justify-content: center;
        ">${ROOM_SERVER_ICON_SVG}</div>
      </div>`;
    }
    
    return `<div style="
      width: ${MARKER_SIZE + 2}px;
      height: ${MARKER_SIZE + 2}px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: ${opacity};
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
      transition: filter 0s ease-in, filter 150ms ease-out;
    ">${ROOM_SERVER_ICON_SVG}</div>`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM Element Factory (for MapLibre Marker)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a DOM element from HTML string.
 * Used by MapLibre Marker's `element` prop.
 */
export function createMarkerElement(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.style.cursor = 'pointer';
  // The first child is the actual marker content
  const content = el.firstElementChild as HTMLElement;
  if (content) {
    // Transfer styles to parent for proper positioning
    el.style.width = content.style.width;
    el.style.height = content.style.height;
  }
  return el;
}
