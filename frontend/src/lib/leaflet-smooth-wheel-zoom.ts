/**
 * Leaflet.SmoothWheelZoom - Cross-platform smooth wheel/gesture zoom
 * 
 * Originally based on: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
 * Heavily modified for modern cross-platform gesture support:
 * - macOS trackpad (pixel-based, high-frequency, momentum scrolling)
 * - Windows trackpad/precision touchpad (WM_POINTER events)
 * - Linux trackpad (libinput)
 * - Traditional mouse wheels (line-based, discrete steps)
 * - Mobile pinch-to-zoom (touch events)
 * 
 * MIT License
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Note: This file uses `any` extensively because Leaflet's Handler.extend() pattern
// creates dynamic objects with internal properties that don't have public type definitions.
// Properly typing all of Leaflet's internal APIs would be complex and brittle.

import L from 'leaflet';

// Extend Leaflet's MapOptions interface
declare module 'leaflet' {
  interface MapOptions {
    smoothWheelZoom?: boolean | 'center';
    smoothSensitivity?: number;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Platform Detection & Sensitivity Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect input characteristics from WheelEvent to determine appropriate sensitivity.
 * 
 * WheelEvent.deltaMode values:
 * - DOM_DELTA_PIXEL (0): Pixel-precise scrolling (trackpads, precision touchpads)
 * - DOM_DELTA_LINE (1): Line-based scrolling (traditional mouse wheels)
 * - DOM_DELTA_PAGE (2): Page-based scrolling (rare, PgUp/PgDn)
 * 
 * Modern trackpads report sub-pixel deltas at high frequency (60-120Hz).
 * Traditional mice report larger deltas (typically 100-120 pixels per notch).
 */
const DELTA_MODE = {
  PIXEL: 0,
  LINE: 1,
  PAGE: 2,
} as const;

/**
 * Sensitivity multipliers calibrated per input type.
 * These convert raw delta values to zoom level changes.
 * 
 * Target feel: ~3-4 scroll gestures to zoom from min to max (~10 zoom levels)
 */
const SENSITIVITY = {
  // Trackpad pixel deltas are small (1-10px typically) and high-frequency
  // macOS trackpads can generate 50-200px per gesture with momentum
  TRACKPAD_PIXEL: 0.0008,
  
  // Mouse wheel line deltas are typically 3 lines per notch
  // Leaflet's getWheelDelta normalizes to ~120 per notch
  MOUSE_LINE: 0.0025,
  
  // Page-based scrolling (rare)
  PAGE: 0.05,
  
  // Pinch gesture scale factor (touch events report scale multiplier)
  PINCH: 1.5,
} as const;

/**
 * Animation smoothing factors.
 * Higher = snappier response, lower = smoother but laggier.
 */
const ANIMATION = {
  // How quickly zoom interpolates toward goal (0-1)
  // 0.25 feels smooth on trackpads, responsive on mice
  ZOOM_LERP: 0.25,
  
  // Minimum zoom change to continue animating (prevents infinite micro-updates)
  ZOOM_EPSILON: 0.001,
  
  // Timeout before considering gesture complete (ms)
  // Trackpads need longer due to momentum scrolling
  WHEEL_TIMEOUT_TRACKPAD: 150,
  WHEEL_TIMEOUT_MOUSE: 80,
  
  // Debounce time for detecting input type transitions (ms)
  INPUT_TYPE_DEBOUNCE: 500,
} as const;

/**
 * Detect if running on macOS (trackpad gestures behave differently)
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Detect if the browser supports passive event listeners.
 */
const SUPPORTS_PASSIVE = (() => {
  let passive = false;
  try {
    const opts = Object.defineProperty({}, 'passive', {
      get: function() { passive = true; return true; }
    });
    window.addEventListener('testPassive', null as any, opts);
    window.removeEventListener('testPassive', null as any, opts);
  } catch { /* ignore */ }
  return passive;
})();

// Merge default options into L.Map
L.Map.mergeOptions({
  smoothWheelZoom: true,
  smoothSensitivity: 1,
});

// ═══════════════════════════════════════════════════════════════════════════════
// SmoothWheelZoom Handler
// ═══════════════════════════════════════════════════════════════════════════════

const SmoothWheelZoom = L.Handler.extend({
  addHooks: function (this: any) {
    const container = this._map.getContainer();
    
    // Use passive: false to allow preventDefault (required for zoom)
    const wheelOpts = SUPPORTS_PASSIVE ? { passive: false, capture: false } : false;
    container.addEventListener('wheel', this._onWheelScroll.bind(this), wheelOpts);
    
    // Touch gesture support (pinch-to-zoom)
    container.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: true });
    container.addEventListener('touchmove', this._onTouchMove.bind(this), { passive: false });
    container.addEventListener('touchend', this._onTouchEnd.bind(this), { passive: true });
    
    // Track gesture state for macOS two-finger detection
    container.addEventListener('gesturestart', this._onGestureStart.bind(this), { passive: false });
    container.addEventListener('gesturechange', this._onGestureChange.bind(this), { passive: false });
    container.addEventListener('gestureend', this._onGestureEnd.bind(this), { passive: true });
    
    // Initialize state
    this._lastInputType = 'unknown';
    this._lastInputTime = 0;
    this._touchStartDistance = 0;
    this._touchStartZoom = 0;
    this._isGesturing = false;
  },

  removeHooks: function (this: any) {
    const container = this._map.getContainer();
    container.removeEventListener('wheel', this._onWheelScroll.bind(this));
    container.removeEventListener('touchstart', this._onTouchStart.bind(this));
    container.removeEventListener('touchmove', this._onTouchMove.bind(this));
    container.removeEventListener('touchend', this._onTouchEnd.bind(this));
    container.removeEventListener('gesturestart', this._onGestureStart.bind(this));
    container.removeEventListener('gesturechange', this._onGestureChange.bind(this));
    container.removeEventListener('gestureend', this._onGestureEnd.bind(this));
  },

  // ─── INPUT TYPE DETECTION ─────────────────────────────────────────────────────
  
  /**
   * Detect whether input is from a trackpad or mouse wheel.
   * Uses multiple heuristics since browsers don't expose this directly.
   */
  _detectInputType: function (this: any, e: WheelEvent): 'trackpad' | 'mouse' {
    // deltaMode is the most reliable indicator
    // PIXEL mode (0) = trackpad, LINE mode (1) = mouse wheel
    if (e.deltaMode === DELTA_MODE.LINE || e.deltaMode === DELTA_MODE.PAGE) {
      return 'mouse';
    }
    
    // For PIXEL mode, use additional heuristics:
    
    // 1. Check for fractional deltas (trackpads often report sub-pixel)
    const hasDecimal = e.deltaY % 1 !== 0 || e.deltaX % 1 !== 0;
    if (hasDecimal) {
      return 'trackpad';
    }
    
    // 2. Check delta magnitude - mouse wheels typically report larger discrete jumps
    // Trackpad pixel deltas are usually small per-event (<50px)
    // Mouse wheels normalized to pixels are usually 100-120px per notch
    const absDelta = Math.abs(e.deltaY) || Math.abs(e.deltaX);
    if (absDelta > 0 && absDelta < 50) {
      return 'trackpad';
    }
    
    // 3. On macOS, wheel events from Magic Mouse/Trackpad use PIXEL mode
    // but can have larger deltas due to momentum - check wheelDeltaY
    // @ts-expect-error - wheelDeltaY is non-standard but present on WebKit
    const wheelDeltaY = e.wheelDeltaY;
    if (typeof wheelDeltaY === 'number') {
      // wheelDeltaY is 3x deltaY for mouse wheels, roughly equal for trackpads
      const ratio = Math.abs(wheelDeltaY / (e.deltaY || 1));
      if (ratio > 2.5 && ratio < 3.5) {
        return 'mouse';
      }
    }
    
    // 4. Frequency heuristic - trackpads fire many small events quickly
    const now = Date.now();
    if (this._lastInputTime && (now - this._lastInputTime) < 20 && absDelta < 30) {
      return 'trackpad';
    }
    this._lastInputTime = now;
    
    // Default to last known type or trackpad (safer - less aggressive zooming)
    return this._lastInputType !== 'unknown' ? this._lastInputType : 'trackpad';
  },
  
  /**
   * Get the appropriate sensitivity multiplier for the detected input type.
   */
  _getSensitivity: function (this: any, e: WheelEvent, inputType: 'trackpad' | 'mouse'): number {
    const map = this._map as L.Map;
    const userSensitivity = map.options.smoothSensitivity ?? 1;
    
    let baseSensitivity: number;
    
    switch (e.deltaMode) {
      case DELTA_MODE.PAGE:
        baseSensitivity = SENSITIVITY.PAGE;
        break;
      case DELTA_MODE.LINE:
        baseSensitivity = SENSITIVITY.MOUSE_LINE;
        break;
      case DELTA_MODE.PIXEL:
      default:
        baseSensitivity = inputType === 'trackpad' 
          ? SENSITIVITY.TRACKPAD_PIXEL 
          : SENSITIVITY.MOUSE_LINE;
        break;
    }
    
    return baseSensitivity * userSensitivity;
  },

  // ─── WHEEL EVENT HANDLERS ─────────────────────────────────────────────────────

  _onWheelScroll: function (this: any, e: WheelEvent) {
    // Don't interfere with native Safari gesture zoom (Ctrl+wheel)
    if (e.ctrlKey && IS_MAC) {
      // This is likely a pinch gesture being reported as wheel
      // Let the gesture handlers deal with it, or handle as pinch
      this._handleCtrlWheel(e);
      return;
    }
    
    if (!this._isWheeling) {
      this._onWheelStart(e);
    }
    this._onWheeling(e);
  },
  
  /**
   * Handle Ctrl+wheel events (pinch gesture on macOS trackpad reported as wheel).
   * Safari and Chrome report pinch gestures as wheel events with ctrlKey=true.
   */
  _handleCtrlWheel: function (this: any, e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    
    const map = this._map as L.Map;
    const userSensitivity = map.options.smoothSensitivity ?? 1;
    
    // Ctrl+wheel pinch gestures report smaller deltas than regular wheel
    // Use a tuned sensitivity for natural feel
    const pinchSensitivity = 0.01 * userSensitivity;
    const zoomDelta = -e.deltaY * pinchSensitivity;
    
    // Get zoom center point
    const mousePos = map.mouseEventToContainerPoint(e);
    const centerLatLng = map.containerPointToLatLng(mousePos);
    
    // Apply zoom immediately with animation
    const newZoom = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), map.getZoom() + zoomDelta)
    );
    
    if (map.options.smoothWheelZoom === 'center') {
      map.setZoom(newZoom, { animate: false });
    } else {
      map.setZoomAround(centerLatLng, newZoom, { animate: false });
    }
  },

  _onWheelStart: function (this: any, e: WheelEvent) {
    const map = this._map as L.Map;
    this._isWheeling = true;
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);
    this._centerPoint = map.getSize().divideBy(2);
    this._startLatLng = map.containerPointToLatLng(this._centerPoint);
    this._wheelStartLatLng = map.containerPointToLatLng(this._wheelMousePosition);
    this._startZoom = map.getZoom();
    this._moved = false;
    this._zooming = true;

    map.stop();
    // @ts-expect-error - accessing internal _panAnim
    if (map._panAnim) map._panAnim.stop();

    this._goalZoom = map.getZoom();
    this._prevCenter = map.getCenter();
    this._prevZoom = map.getZoom();
    
    // Detect input type for this gesture
    this._currentInputType = this._detectInputType(e);
    this._lastInputType = this._currentInputType;

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },

  _onWheeling: function (this: any, e: WheelEvent) {
    const map = this._map as L.Map;
    
    // Re-detect input type (can change mid-gesture on hybrid devices)
    const inputType = this._detectInputType(e);
    this._currentInputType = inputType;
    
    // Get calibrated sensitivity for this input type
    const sensitivity = this._getSensitivity(e, inputType);
    
    // Normalize delta - use deltaY primarily, fall back to deltaX for horizontal scroll
    // Negate because positive deltaY = scroll down = zoom out
    let delta = e.deltaY;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      delta = e.deltaX; // Horizontal scroll on some trackpads
    }
    
    // Apply sensitivity and accumulate to goal zoom
    this._goalZoom = this._goalZoom - delta * sensitivity;
    
    // Clamp to zoom bounds
    // @ts-expect-error - accessing internal _limitZoom
    this._goalZoom = map._limitZoom(this._goalZoom);
    
    // Update mouse position for zoom-around-cursor
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);

    // Set timeout based on input type
    // Trackpads need longer timeout due to momentum scrolling
    clearTimeout(this._timeoutId);
    const timeout = inputType === 'trackpad' 
      ? ANIMATION.WHEEL_TIMEOUT_TRACKPAD 
      : ANIMATION.WHEEL_TIMEOUT_MOUSE;
    this._timeoutId = setTimeout(this._onWheelEnd.bind(this), timeout);

    e.preventDefault();
    e.stopPropagation();
  },

  _onWheelEnd: function (this: any) {
    this._isWheeling = false;
    cancelAnimationFrame(this._zoomAnimationId);
    this._map._moveEnd(true);
  },

  _updateWheelZoom: function (this: any) {
    const map = this._map as L.Map;

    // Check if external pan/zoom interrupted us
    if (!map.getCenter().equals(this._prevCenter) || map.getZoom() !== this._prevZoom) {
      return;
    }
    
    // Calculate zoom step toward goal with smooth interpolation
    const zoomDiff = this._goalZoom - map.getZoom();
    
    // Stop animating if we're close enough
    if (Math.abs(zoomDiff) < ANIMATION.ZOOM_EPSILON) {
      if (!this._isWheeling) {
        return; // Animation complete
      }
    }

    this._zoom = map.getZoom() + zoomDiff * ANIMATION.ZOOM_LERP;
    // Round to prevent floating point accumulation
    this._zoom = Math.round(this._zoom * 1000) / 1000;

    const delta = this._wheelMousePosition.subtract(this._centerPoint);
    
    // Calculate new center
    if (map.options.smoothWheelZoom === 'center') {
      this._center = this._startLatLng;
    } else if (delta.x === 0 && delta.y === 0) {
      // Mouse at center, just zoom
      this._center = map.getCenter();
    } else {
      // Zoom around cursor position
      this._center = map.unproject(
        map.project(this._wheelStartLatLng, this._zoom).subtract(delta),
        this._zoom
      );
    }

    if (!this._moved) {
      // @ts-expect-error - accessing internal _moveStart
      map._moveStart(true, false);
      this._moved = true;
    }

    // @ts-expect-error - accessing internal _move
    map._move(this._center, this._zoom);
    this._prevCenter = map.getCenter();
    this._prevZoom = map.getZoom();

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },
  
  // ─── TOUCH GESTURE HANDLERS (Pinch-to-Zoom) ───────────────────────────────────
  
  _onTouchStart: function (this: any, e: TouchEvent) {
    if (e.touches.length !== 2) return;
    
    // Calculate initial distance between two fingers
    const touch1 = e.touches[0];
    const touch2 = e.touches[1];
    this._touchStartDistance = Math.hypot(
      touch2.clientX - touch1.clientX,
      touch2.clientY - touch1.clientY
    );
    this._touchStartZoom = this._map.getZoom();
    this._touchCenter = {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2,
    };
    this._isPinching = true;
  },
  
  _onTouchMove: function (this: any, e: TouchEvent) {
    if (!this._isPinching || e.touches.length !== 2) return;
    
    e.preventDefault(); // Prevent default zoom on mobile browsers
    
    const map = this._map as L.Map;
    const touch1 = e.touches[0];
    const touch2 = e.touches[1];
    
    // Calculate current distance
    const currentDistance = Math.hypot(
      touch2.clientX - touch1.clientX,
      touch2.clientY - touch1.clientY
    );
    
    // Calculate scale factor
    const scale = currentDistance / this._touchStartDistance;
    
    // Apply zoom with sensitivity
    const userSensitivity = map.options.smoothSensitivity ?? 1;
    const zoomDelta = Math.log2(scale) * SENSITIVITY.PINCH * userSensitivity;
    const newZoom = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), this._touchStartZoom + zoomDelta)
    );
    
    // Get center point of pinch gesture
    const centerX = (touch1.clientX + touch2.clientX) / 2;
    const centerY = (touch1.clientY + touch2.clientY) / 2;
    const containerPoint = L.point(centerX, centerY);
    const latlng = map.containerPointToLatLng(containerPoint);
    
    // Apply zoom around pinch center
    if (map.options.smoothWheelZoom === 'center') {
      map.setZoom(newZoom, { animate: false });
    } else {
      map.setZoomAround(latlng, newZoom, { animate: false });
    }
  },
  
  _onTouchEnd: function (this: any, e: TouchEvent) {
    if (e.touches.length < 2) {
      this._isPinching = false;
    }
  },
  
  // ─── NATIVE GESTURE HANDLERS (Safari/WebKit) ──────────────────────────────────
  // Safari fires native gesture events for trackpad pinch
  
  _onGestureStart: function (this: any, e: Event) {
    e.preventDefault();
    this._isGesturing = true;
    this._gestureStartZoom = this._map.getZoom();
  },
  
  _onGestureChange: function (this: any, e: Event & { scale?: number }) {
    if (!this._isGesturing) return;
    e.preventDefault();
    
    const map = this._map as L.Map;
    const scale = e.scale ?? 1;
    const userSensitivity = map.options.smoothSensitivity ?? 1;
    
    // Convert scale to zoom delta
    const zoomDelta = Math.log2(scale) * SENSITIVITY.PINCH * userSensitivity;
    const newZoom = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), this._gestureStartZoom + zoomDelta)
    );
    
    map.setZoom(newZoom, { animate: false });
  },
  
  _onGestureEnd: function (this: any) {
    this._isGesturing = false;
  },
});

// Register the handler
L.Map.addInitHook('addHandler', 'smoothWheelZoom', SmoothWheelZoom);

export {};
