// A deck.gl Widget that plays back a TripsLayer over time: a play/pause button
// plus a scrub slider, driving `currentTime` via a requestAnimationFrame loop.
//
// By default it targets every layer that looks like a TripsLayer (duck-typed
// on having both trailLength and currentTime props — see _isTripsLayer;
// layer.constructor.name isn't reliable since production deck.gl bundles are
// minified and mangle it) — pass `layerIds` to restrict it to specific ids.
//
// Animating means re-deriving each target layer with an updated `currentTime`
// via `new LayerClass({...layer.props, currentTime})` and calling
// `deck.setProps({layers})`. `layer.props` already carries every resolved
// accessor/data prop from the original JSON conversion, and reusing the same
// `id` (spread in from `layer.props`) is what lets deck.gl diff/update the
// layer cheaply instead of tearing it down and rebuilding from scratch.
//
// Two optional add-ons, both driven by the same tick — no data re-upload,
// no HTML string-templating, just more deck.setProps calls of the same shape:
//
// - Head markers (headLayerIds): a ScatterplotLayer/ScenegraphLayer whose rows
//   already carry the same path+timestamps a TripsLayer would (pathField /
//   timestampField, dotted paths into each row). Each tick we interpolate a
//   position (and a heading, held steady below minMoveMeters so a stationary
//   subject doesn't spin in place) and write it back onto positionField /
//   headingField — the same field names the layer's own getPosition /
//   getOrientation accessors were pointed at when the layer was created.
// - Auto-rotate (autoRotateSpeed): advances camera bearing each tick via
//   deck.setProps({viewState}). deck.gl treats supplying viewState at all as
//   "this app now owns the view", so from that point on user pan/zoom only
//   keeps working because we also take over onViewStateChange and mirror
//   whatever it reports back into the next tick's viewState.

import { Widget } from '@deck.gl/core';

export class AnimationWidget extends Widget {
  placement = 'bottom-left';
  className = 'my-animation-widget';

  constructor(props) {
    super(props, AnimationWidget.defaultProps);
    this._playing = false;
    this._currentTime = this.props.minTime;
    this._rafId = null;
    this._lastFrameTs = null;
    this._built = false;

    // deck.gl transforms the exposed `data` prop internally after a layer's
    // first render pass (observed: TripsLayer's props.data.length reads 0
    // from the very next tick onward), so re-spreading layer.props on every
    // frame propagates that emptied value forward. Cache each targeted
    // layer's pristine data the first time we see it, keyed by layer id, and
    // always reconstruct from that instead of whatever .props.data currently is.
    this._pristineData = new Map();

    // Head-marker interpolation state, keyed by `${layerId}:${rowIndex}`.
    this._cursors = new Map();
    this._headings = new Map();

    // Auto-rotate state. deck.gl's viewState prop is keyed by view id (e.g.
    // {"default-view": {longitude, latitude, zoom, bearing, pitch, ...}}),
    // not a flat object — _viewId/_lastViewState track that per-view shape.
    this._viewId = null;
    this._lastViewState = null;
    this._rotateBearing = null;
    this._lastRotateTs = null;
    this._origOnViewStateChange = null;
    this._rotationHookInstalled = false;
  }

  onAdd() {
    if (this.props.autoplay) this._start();
  }

  onRemove() {
    this._stop();
  }

  onRenderHTML(rootElement) {
    if (!this._built) {
      this._build(rootElement);
      this._built = true;
    }
    this._updateUI();
  }

  _build(root) {
    Object.assign(root.style, {
      // WidgetManager sets pointer-events: none on the placement container so
      // widgets don't block map dragging by default; the official
      // @deck.gl/widgets stylesheet only opts specific button markup back in,
      // so we re-enable it ourselves rather than depend on that stylesheet
      // being loaded by whatever page embeds this widget.
      pointerEvents: 'auto',
      background: 'white',
      padding: '8px 10px',
      borderRadius: '4px',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
      font: '12px sans-serif',
      color: '#333',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minWidth: '220px'
    });

    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.style.cursor = 'pointer';
    this._btn.style.border = 'none';
    this._btn.style.background = 'transparent';
    this._btn.style.font = 'inherit';
    this._btn.addEventListener('click', () => {
      if (this._playing) this._stop();
      else this._start();
      this._updateUI();
    });

    this._slider = document.createElement('input');
    this._slider.type = 'range';
    this._slider.min = '0';
    this._slider.max = '1000';
    this._slider.style.flex = '1';
    this._slider.addEventListener('input', (event) => {
      this._stop();
      const frac = Number(event.target.value) / 1000;
      const { minTime, maxTime } = this.props;
      this._currentTime = minTime + frac * (maxTime - minTime);
      this._applyFrame();
      this._updateUI();
    });

    this._label = document.createElement('span');
    this._label.style.minWidth = '40px';
    this._label.style.textAlign = 'right';

    root.appendChild(this._btn);
    root.appendChild(this._slider);
    root.appendChild(this._label);
  }

  _updateUI() {
    if (!this._btn) return;
    this._btn.textContent = this._playing ? '⏸' : '▶';
    const { minTime, maxTime } = this.props;
    const span = maxTime - minTime;
    const frac = span > 0 ? (this._currentTime - minTime) / span : 0;
    this._slider.value = String(Math.round(frac * 1000));
    this._label.textContent = `${Math.round(frac * 100)}%`;
  }

  _start() {
    const { minTime, maxTime, durationMs } = this.props;
    if (this._rafId != null || maxTime <= minTime || durationMs <= 0) return;

    this._playing = true;
    this._lastFrameTs = null;

    const step = (ts) => {
      if (this._lastFrameTs == null) this._lastFrameTs = ts;
      const dt = ts - this._lastFrameTs;
      this._lastFrameTs = ts;

      const span = maxTime - minTime;
      this._currentTime += (dt / durationMs) * span;

      if (this._currentTime >= maxTime) {
        if (this.props.loop) {
          this._currentTime = minTime + ((this._currentTime - minTime) % span);
        } else {
          this._currentTime = maxTime;
          this._playing = false;
        }
      }

      this._applyFrame();
      this._updateUI();

      this._rafId = this._playing ? requestAnimationFrame(step) : null;
    };
    this._rafId = requestAnimationFrame(step);
  }

  _stop() {
    this._playing = false;
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // One combined update per tick: sweep every TripsLayer's currentTime,
  // recompute every head-marker layer's interpolated position/heading, then
  // apply both in a single deck.setProps({layers}) — then rotate the camera.
  _applyFrame() {
    if (!this.deck) return;
    const { layerIds, headLayerIds } = this.props;
    const currentLayers = this.deck.props.layers || [];

    const nextLayers = currentLayers.map((layer) => {
      if (!layer) return layer;

      if (headLayerIds && headLayerIds.includes(layer.id)) {
        return this._applyHeadLayer(layer);
      }

      const isTripsTarget =
        layerIds && layerIds.length ? layerIds.includes(layer.id) : this._isTripsLayer(layer);
      if (!isTripsTarget) return layer;

      if (!this._pristineData.has(layer.id)) {
        this._pristineData.set(layer.id, layer.props.data);
      }

      const LayerClass = layer.constructor;
      return new LayerClass({
        ...layer.props,
        data: this._pristineData.get(layer.id),
        currentTime: this._currentTime
      });
    });

    this.deck.setProps({ layers: nextLayers });
    this._applyRotation();
  }

  // Duck-type on trailLength/currentTime rather than layer.constructor.name:
  // production/CDN deck.gl bundles are minified, so the runtime class name is
  // mangled (e.g. "nh", not "TripsLayer") and a name check silently matches
  // nothing. trailLength+currentTime together are unique to TripsLayer among
  // deck.gl's own layers, so this is unaffected by minification either way.
  _isTripsLayer(layer) {
    return !!layer.props && 'trailLength' in layer.props && 'currentTime' in layer.props;
  }

  _resolveField(row, dottedPath) {
    return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), row);
  }

  // Bearing (deg, 0 = north) and ground distance (m) from point a to point b,
  // both [lon, lat(, z)]. Flat-earth approximation — plenty accurate at the
  // scale of one interpolation step between consecutive track fixes.
  _headingAndDistance(a, b) {
    const midLatRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    const dEastDeg = (b[0] - a[0]) * Math.cos(midLatRad);
    const dNorthDeg = b[1] - a[1];
    const heading =
      dEastDeg === 0 && dNorthDeg === 0 ? null : (Math.atan2(dEastDeg, dNorthDeg) * 180) / Math.PI;
    const METERS_PER_DEG = 111320;
    const distance = Math.hypot(dEastDeg, dNorthDeg) * METERS_PER_DEG;
    return { heading, distance };
  }

  // Interpolated [lon, lat, z] + held-steady heading for one row's path at
  // time t, using a monotonic per-row cursor (cacheKey) so repeated forward
  // playback doesn't rescan the whole path every tick.
  _interpolateRow(path, timestamps, t, cacheKey) {
    const last = timestamps.length - 1;
    if (last < 0 || path.length !== timestamps.length) return null;

    let j;
    if (t <= timestamps[0]) {
      j = 0;
    } else if (t >= timestamps[last]) {
      j = Math.max(0, last - 1);
    } else {
      j = this._cursors.get(cacheKey) ?? 0;
      if (t < timestamps[j]) j = 0;
      while (j < last - 1 && timestamps[j + 1] < t) j++;
    }
    this._cursors.set(cacheKey, j);

    const j1 = Math.min(j + 1, last);
    const t0 = timestamps[j];
    const t1 = timestamps[j1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;

    const a = path[j];
    const b = path[j1];
    const position = [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * f
    ];

    const { heading, distance } = this._headingAndDistance(a, b);
    let finalHeading = this._headings.get(cacheKey) ?? 0;
    if (heading != null && distance >= this.props.minMoveMeters) {
      finalHeading = heading;
      this._headings.set(cacheKey, heading);
    }

    return { position, heading: finalHeading };
  }

  _applyHeadLayer(layer) {
    const { pathField, timestampField, positionField, headingField, orientationField } = this.props;
    const data = layer.props.data || [];

    const nextData = data.map((row, i) => {
      const path = this._resolveField(row, pathField);
      const timestamps = this._resolveField(row, timestampField);
      if (!path || !timestamps || !path.length || !timestamps.length) return row;

      const result = this._interpolateRow(path, timestamps, this._currentTime, `${layer.id}:${i}`);
      if (!result) return row;

      return {
        ...row,
        [positionField]: result.position,
        [headingField]: result.heading,
        // [pitch, yaw, roll] in degrees, for a ScenegraphLayer's getOrientation
        // (yaw negated so the model's nose faces the direction of travel).
        [orientationField]: [0, -result.heading, 0]
      };
    });

    const LayerClass = layer.constructor;
    return new LayerClass({ ...layer.props, data: nextData });
  }

  _applyRotation() {
    const speed = this.props.autoRotateSpeed;
    if (!speed || !this.deck) return;

    // Installed lazily on the first tick (a later requestAnimationFrame
    // turn) rather than from onAdd(): onAdd() runs synchronously inside
    // deck.gl's own constructor-time setProps, and calling deck.setProps(...)
    // again from in there re-enters it and blows the call stack.
    if (!this._rotationHookInstalled) {
      // Seed from whatever deck already resolved from initialViewState —
      // deck.viewState is the per-view map plus a flat convenience copy of
      // the first view (see the field list below); we want the per-id entry
      // so later merges stay keyed the same way deck.gl itself expects.
      const seed = this.deck.viewState || {};
      this._viewId = Object.keys(seed).find((k) => k !== 'width' && k !== 'height' && typeof seed[k] === 'object') || 'default-view';
      this._lastViewState = seed[this._viewId] || {
        longitude: seed.longitude,
        latitude: seed.latitude,
        zoom: seed.zoom,
        bearing: seed.bearing || 0,
        pitch: seed.pitch || 0
      };

      // Once we push our own `viewState` prop, deck.gl stops auto-applying
      // interaction updates internally (that's now "our" job) — so from here
      // on, every onViewStateChange must feed the result straight back via
      // setProps, or user drag/zoom/rotate would visually freeze.
      this._origOnViewStateChange = this.deck.props.onViewStateChange || null;
      this.deck.setProps({
        onViewStateChange: (params) => {
          const viewId = params.viewId || this._viewId;
          const result = this._origOnViewStateChange ? this._origOnViewStateChange(params) : params.viewState;
          const nextViewState = result || params.viewState;
          this._viewId = viewId;
          this._lastViewState = nextViewState;
          this.deck.setProps({ viewState: { [viewId]: nextViewState } });
          return nextViewState;
        }
      });
      this._rotationHookInstalled = true;
    }

    if (!this._lastViewState) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this._lastRotateTs != null ? now - this._lastRotateTs : 0;
    this._lastRotateTs = now;

    if (this._rotateBearing == null) this._rotateBearing = this._lastViewState.bearing || 0;
    this._rotateBearing = (this._rotateBearing + (speed * dt) / 1000) % 360;

    this._lastViewState = { ...this._lastViewState, bearing: this._rotateBearing };
    this.deck.setProps({ viewState: { [this._viewId]: this._lastViewState } });
  }
}

AnimationWidget.defaultProps = {
  ...Widget.defaultProps,
  id: 'animation-widget',
  minTime: 0,
  maxTime: 1,
  durationMs: 15000,
  loop: true,
  autoplay: true,
  layerIds: null,
  // Head-marker tracking (null -> disabled).
  headLayerIds: null,
  pathField: 'geometry.coordinates',
  timestampField: 'times',
  positionField: 'position',
  headingField: 'heading',
  orientationField: 'orientation',
  minMoveMeters: 3,
  // Auto-rotate (0 -> disabled). Degrees per second; +clockwise.
  autoRotateSpeed: 0
};
