/**
 * Leaflet.SmoothWheelZoom - Google Maps-style smooth wheel zoom
 * 
 * Original: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
 * MIT License - Copyright (c) mutsuyuki
 * 
 * Ported to TypeScript for react-leaflet integration.
 */

import L from 'leaflet';

// Extend Leaflet's MapOptions interface
declare module 'leaflet' {
  interface MapOptions {
    smoothWheelZoom?: boolean | 'center';
    smoothSensitivity?: number;
  }
}

// Merge default options into L.Map
L.Map.mergeOptions({
  smoothWheelZoom: true,
  smoothSensitivity: 1,
});

// Create the SmoothWheelZoom handler
const SmoothWheelZoom = L.Handler.extend({
  addHooks: function (this: any) {
    L.DomEvent.on(this._map.getContainer(), 'wheel', this._onWheelScroll, this);
  },

  removeHooks: function (this: any) {
    L.DomEvent.off(this._map.getContainer(), 'wheel', this._onWheelScroll, this);
  },

  _onWheelScroll: function (this: any, e: WheelEvent) {
    if (!this._isWheeling) {
      this._onWheelStart(e);
    }
    this._onWheeling(e);
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

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },

  _onWheeling: function (this: any, e: WheelEvent) {
    const map = this._map as L.Map;

    this._goalZoom = this._goalZoom + L.DomEvent.getWheelDelta(e) * 0.003 * (map.options.smoothSensitivity ?? 1);
    if (this._goalZoom < map.getMinZoom() || this._goalZoom > map.getMaxZoom()) {
      // @ts-expect-error - accessing internal _limitZoom
      this._goalZoom = map._limitZoom(this._goalZoom);
    }
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);

    clearTimeout(this._timeoutId);
    this._timeoutId = setTimeout(this._onWheelEnd.bind(this), 200);

    L.DomEvent.preventDefault(e);
    L.DomEvent.stopPropagation(e);
  },

  _onWheelEnd: function (this: any) {
    this._isWheeling = false;
    cancelAnimationFrame(this._zoomAnimationId);
    this._map._moveEnd(true);
  },

  _updateWheelZoom: function (this: any) {
    const map = this._map as L.Map;

    if (!map.getCenter().equals(this._prevCenter) || map.getZoom() !== this._prevZoom) {
      return;
    }

    this._zoom = map.getZoom() + (this._goalZoom - map.getZoom()) * 0.3;
    this._zoom = Math.floor(this._zoom * 100) / 100;

    const delta = this._wheelMousePosition.subtract(this._centerPoint);
    if (delta.x === 0 && delta.y === 0) {
      return;
    }

    if (map.options.smoothWheelZoom === 'center') {
      this._center = this._startLatLng;
    } else {
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
});

// Register the handler
L.Map.addInitHook('addHandler', 'smoothWheelZoom', SmoothWheelZoom);

export {};
