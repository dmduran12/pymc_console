/**
 * Map Icon System
 * 
 * Leaflet DivIcon factories for all node types.
 * Includes caching system to avoid expensive DOM string parsing.
 */

import L from 'leaflet';
import { Home, MessagesSquare } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MARKER_SIZE,
  RING_THICKNESS,
  NEIGHBOR_OUTER_RING_SIZE,
  NEIGHBOR_RING_THICKNESS,
  ICON_CACHE_MAX_SIZE,
  DESIGN,
} from './constants';

// ═══════════════════════════════════════════════════════════════════════════════
// Icon Cache
// ═══════════════════════════════════════════════════════════════════════════════
// Leaflet DivIcon instances are expensive to create (DOM string parsing).
// Since opacity is quantized to 20 steps and hover/neighbor are boolean,
// the parameter space is bounded. Cache icons by their parameter signature.

const iconCache = new Map<string, L.DivIcon>();

/**
 * Get a cached icon or create and cache a new one.
 * @param cacheKey - Unique key for this icon configuration
 * @param createFn - Factory function to create the icon if not cached
 */
function getCachedIcon(cacheKey: string, createFn: () => L.DivIcon): L.DivIcon {
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;
  
  // Evict oldest entries if cache is full (simple FIFO eviction)
  if (iconCache.size >= ICON_CACHE_MAX_SIZE) {
    const firstKey = iconCache.keys().next().value;
    if (firstKey) iconCache.delete(firstKey);
  }
  
  const icon = createFn();
  iconCache.set(cacheKey, icon);
  return icon;
}

/** Clear the icon cache (useful for testing or theme changes) */
export function clearIconCache(): void {
  iconCache.clear();
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
// Icon Factories
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a ring (torus) icon for standard nodes.
 * Thick ring with small donut hole - no stroke, just the ring itself.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param color - Ring color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createRingIcon(
  color: string = DESIGN.nodeColor,
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): L.DivIcon {
  // Build cache key from parameters
  const cacheKey = `ring:${color}:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIcon(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the main marker
    if (isNeighbor) {
      const offset = (NEIGHBOR_OUTER_RING_SIZE - MARKER_SIZE) / 2;
      return L.divIcon({
        className: 'map-ring-marker-neighbor',
        html: `<div style="
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
        </div>`,
        iconSize: [NEIGHBOR_OUTER_RING_SIZE, NEIGHBOR_OUTER_RING_SIZE],
        iconAnchor: [NEIGHBOR_OUTER_RING_SIZE / 2, NEIGHBOR_OUTER_RING_SIZE / 2],
        popupAnchor: [0, -NEIGHBOR_OUTER_RING_SIZE / 2],
      });
    }
    
    return L.divIcon({
      className: 'map-ring-marker',
      html: `<div style="
        width: ${MARKER_SIZE}px;
        height: ${MARKER_SIZE}px;
        background: transparent;
        border-radius: 50%;
        border: ${RING_THICKNESS}px solid ${color};
        box-sizing: border-box;
        opacity: ${opacity};
        filter: brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      "></div>`,
      iconSize: [MARKER_SIZE, MARKER_SIZE],
      iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
      popupAnchor: [0, -MARKER_SIZE / 2],
    });
  });
}

/**
 * Create a filled dot icon for hub nodes.
 * Same outer dimension as ring - no border/stroke.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param color - Fill color
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createFilledIcon(
  color: string = DESIGN.hubColor,
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): L.DivIcon {
  // Build cache key from parameters
  const cacheKey = `filled:${color}:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIcon(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the hub marker
    if (isNeighbor) {
      const offset = (NEIGHBOR_OUTER_RING_SIZE - MARKER_SIZE) / 2;
      return L.divIcon({
        className: 'map-filled-marker-neighbor',
        html: `<div style="
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
        </div>`,
        iconSize: [NEIGHBOR_OUTER_RING_SIZE, NEIGHBOR_OUTER_RING_SIZE],
        iconAnchor: [NEIGHBOR_OUTER_RING_SIZE / 2, NEIGHBOR_OUTER_RING_SIZE / 2],
        popupAnchor: [0, -NEIGHBOR_OUTER_RING_SIZE / 2],
      });
    }
    
    return L.divIcon({
      className: 'map-filled-marker',
      html: `<div style="
        width: ${MARKER_SIZE}px;
        height: ${MARKER_SIZE}px;
        background-color: ${color};
        border-radius: 50%;
        box-sizing: border-box;
        opacity: ${opacity};
        filter: brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      "></div>`,
      iconSize: [MARKER_SIZE, MARKER_SIZE],
      iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
      popupAnchor: [0, -MARKER_SIZE / 2],
    });
  });
}

/**
 * Create local node icon - yellow house icon to indicate "home" node.
 * Uses lucide-react Home icon rendered as static SVG.
 * 
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 */
export function createLocalIcon(isHovered: boolean = false): L.DivIcon {
  // Build cache key from parameters (only hover state varies)
  const cacheKey = `local:${isHovered}`;
  
  return getCachedIcon(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    return L.divIcon({
      className: 'map-local-marker',
      html: `<div style="
        width: ${MARKER_SIZE + 2}px;
        height: ${MARKER_SIZE + 2}px;
        display: flex;
        align-items: center;
        justify-content: center;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      ">${HOME_ICON_SVG}</div>`,
      iconSize: [MARKER_SIZE + 2, MARKER_SIZE + 2],
      iconAnchor: [(MARKER_SIZE + 2) / 2, (MARKER_SIZE + 2) / 2],
      popupAnchor: [0, -(MARKER_SIZE + 2) / 2],
    });
  });
}

/**
 * Create room server icon - amber chat bubble icon.
 * Uses lucide-react MessagesSquare icon rendered as static SVG.
 * Optionally includes a yellow outer ring for neighbor indication.
 * 
 * @param opacity - Opacity 0-1 (for fade animations)
 * @param isHovered - Whether the node is currently hovered (adds brightness)
 * @param isNeighbor - Whether this node is a zero-hop neighbor (adds yellow outer ring)
 */
export function createRoomServerIcon(
  opacity: number = 1,
  isHovered: boolean = false,
  isNeighbor: boolean = false
): L.DivIcon {
  // Build cache key from parameters
  const cacheKey = `roomserver:${opacity}:${isHovered}:${isNeighbor}`;
  
  return getCachedIcon(cacheKey, () => {
    // Hover: instant on, ease-out off (150ms)
    const brightness = isHovered ? 1.25 : 1;
    
    // Neighbor indicator: yellow outer ring wrapping the icon
    if (isNeighbor) {
      const iconSize = MARKER_SIZE + 2;
      const offset = (NEIGHBOR_OUTER_RING_SIZE - iconSize) / 2;
      return L.divIcon({
        className: 'map-room-server-marker-neighbor',
        html: `<div style="
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
        </div>`,
        iconSize: [NEIGHBOR_OUTER_RING_SIZE, NEIGHBOR_OUTER_RING_SIZE],
        iconAnchor: [NEIGHBOR_OUTER_RING_SIZE / 2, NEIGHBOR_OUTER_RING_SIZE / 2],
        popupAnchor: [0, -NEIGHBOR_OUTER_RING_SIZE / 2],
      });
    }
    
    return L.divIcon({
      className: 'map-room-server-marker',
      html: `<div style="
        width: ${MARKER_SIZE + 2}px;
        height: ${MARKER_SIZE + 2}px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: ${opacity};
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) brightness(${brightness});
        transition: filter 0s ease-in, filter 150ms ease-out;
      ">${ROOM_SERVER_ICON_SVG}</div>`,
      iconSize: [MARKER_SIZE + 2, MARKER_SIZE + 2],
      iconAnchor: [(MARKER_SIZE + 2) / 2, (MARKER_SIZE + 2) / 2],
      popupAnchor: [0, -(MARKER_SIZE + 2) / 2],
    });
  });
}
