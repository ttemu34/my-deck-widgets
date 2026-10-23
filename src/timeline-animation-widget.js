// A deck.gl Widget that animates any number of layers from one shared clock: the
// engine behind ecoscope-workflows-ext-mep's draw_animated_map.
//
// Each entry of `layerSpecs` names a layer (by id) and an animator kind; ANIMATORS
// turns the base layer + current time into the layers actually drawn this frame:
//
// - 'trips': a TripsLayer becomes a comet over a historic trail (+ optional glow),
//   with a head marker (dot or glTF model), pulse ring, labels, data-gap lines/tags,
//   hover tooltips and click-to-follow.
// - 'window': any layer with a per-row time (`__t`, or `properties.__t`) shows only
//   the rows inside [t - window, t], faded via DataFilterExtension on the GPU.
//
// Also: sun lighting that follows the data's real time, auto-rotate, and a playback
// bar (PlaybackControls). Every time is in seconds on the shared timeline, which
// starts at 0; `t0` is that 0 in epoch seconds (for the clock label and the sun).
//
// The widget renders no UI of its own in its placement corner: the playback bar
// is a centred overlay (#timeline-controls) so the corner widgets stay put.
//
// Page globals it publishes (the Python side depends on these):
// - window.deckInstance: the Deck, for the headless video exporter and the
//   Camera panel.
// - window.__tripsAnim: deterministic render bridge (ready, headReady, span,
//   durationSec, specs, time, pause/play/renderAt/setView). The exporter pauses
//   autoplay and paints exact frames through it.
// It reads window.__camPreview / __camPreviewOn / __camPanel when the Camera
// panel (CameraPanelWidget) is on the page.

import { Widget } from '@deck.gl/core';

export class TimelineAnimationWidget extends Widget {
  placement = 'bottom-left';
  className = 'timeline-animation-widget';

  constructor(props) {
    super(props, TimelineAnimationWidget.defaultProps);
    this._timeline = null;
  }

  onAdd({ deck }) {
    // onAdd runs inside deck's own setProps, so the timeline only touches the deck
    // once its layers exist (polled, like the inline script this replaces).
    window.deckInstance = deck;
    this._timeline = createTimeline(deck, this.props);
  }

  onRemove() {
    if (this._timeline) this._timeline.destroy();
    this._timeline = null;
  }

  onRenderHTML(rootElement) {
    rootElement.style.display = 'none';
  }
}

TimelineAnimationWidget.defaultProps = {
  ...Widget.defaultProps,
  id: 'timeline-animation',
  layerSpecs: [],
  maxTime: 1,           // timeline length in seconds of data time
  t0: 0,                // epoch seconds at timeline 0
  durationS: 30,        // playback length in wall-clock seconds
  fpsLimit: 60,
  autoRotateSpeed: 0,   // deg/s; 0 = off
  sun: { on: false, night: 0.45, smoothS: 0.3 },
  controls: { visible: false }  // PlaybackControls, snake_case keys as dumped by pydantic
};

function createTimeline(deck, props) {
  const LAYER_SPECS     = props.layerSpecs;
  const maxTime         = props.maxTime;
  const T0              = props.t0;
  const CONTROLS        = props.controls;
  const durationSec     = props.durationS;
  const timePerMs       = maxTime / (durationSec * 1000);  // timeline units per wall-clock ms
  const fpsInterval     = 1000 / props.fpsLimit;
  const autoRotateSpeed = props.autoRotateSpeed;
  const SUN             = props.sun;                     // { on, night, smoothS }: sun lighting at the data time
  const CPU_FILTER_LAYERS = ['HexagonLayer'];            // aggregation layers: filter rows, not on the GPU

  let currentTime   = 0;
  let isPlaying     = true;
  let destroyed     = false;
  let lastFrameTime = 0;
  let lastTickTs    = null;  // wall clock of the last advance; null -> next frame advances 0
  let baseLayers    = null;
  let animatedById  = null;  // layer id -> { base, spec, animator, state }
  let ScatterCtor    = null; // resolved lazily
  let ScenegraphCtor = null; // loaded lazily, only when a 3D head model is configured
  let DataFilterCtor = null; // loaded lazily, only when a time-window layer exists
  let rotateBearing  = 0;    // accumulated bearing for smooth rotation
  let lastRotateTs   = 0;    // last frame timestamp used for rotation delta
  let _deckViewState = null; // mirrors interactive view state so rotation + user pan compose
  let userInteracting = false; // user is mid-drag/zoom -> hold auto-rotation
  let TextCtor  = null;      // labels and 'no data' tags
  let LineCtor  = null;      // faint lines across data gaps
  let sunLight  = null;      // DirectionalLight that sunAt() moves with the clock (SUN.on)
  let following = null;      // { layerId, fi }: the marker the camera follows (click_to_follow)

  const needsModel  = LAYER_SPECS.some(function (s) { return s.kind === 'trips' && s.head.kind === 'model'; });
  // ScatterplotLayer draws the dot marker and the pulse ring
  const needsDot    = LAYER_SPECS.some(function (s) { return s.kind === 'trips' && s.head.kind !== 'none'; });
  const needsFilter = LAYER_SPECS.some(function (s) { return s.kind === 'window'; });
  let __headReady   = !needsModel;
  let __filterReady = !needsFilter;

  // Resolve a deck.gl class without hard-coding the global namespace.
  function resolveLayer(name) {
    const cands = [window.deck, window.deckgl, window.DeckGL, window];
    for (const ns of cands) {
      if (ns && typeof ns[name] === 'function') return ns[name];
    }
    for (const k in window) {                       // last resort: scan
      try {
        const v = window[k];
        if (v && typeof v[name] === 'function') return v[name];
      } catch (e) { /* ignore cross-origin / getter throws */ }
    }
    return null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // deck.gl's standalone module bundles replace window.deck with only their own exports,
  // so load them one at a time, hand back the module, and restore the full namespace.
  // Loaded from unpkg at the page's deck.gl version rather than bundled here: a bundled
  // copy could drift from the deck.gl that pydeck loads.
  let _moduleChain = Promise.resolve();
  function loadDeckModule(pkg) {
    const run = async function () {
      const prev = window.deck;
      const ver = (prev && prev.VERSION) || 'latest';
      try {
        await loadScript('https://unpkg.com/' + pkg + '@' + ver + '/dist.min.js');
        return window.deck;
      } finally {
        window.deck = prev;
      }
    };
    const p = _moduleChain.then(run, run);
    _moduleChain = p.catch(function () {});
    return p;
  }

  async function ensureScenegraph() {
    const found = resolveLayer('ScenegraphLayer');
    if (found) return found;
    try {
      const mod = await loadDeckModule('@deck.gl/mesh-layers');
      await loadScript('https://unpkg.com/@loaders.gl/gltf@^4.0.0/dist/dist.min.js');
      const reg = (window.deck && window.deck.registerLoaders) ||
                  (window.loaders && window.loaders.registerLoaders);
      const GLTFLoader = window.loaders && window.loaders.GLTFLoader;
      if (reg && GLTFLoader) { try { reg([GLTFLoader]); } catch (e) {} }
      return (mod && mod.ScenegraphLayer) || null;
    } catch (e) {
      console.warn('[TimelineAnimationWidget] could not load ScenegraphLayer/glTF loader; ' +
                   'falling back to the 2D head dot.', e);
      return null;
    }
  }

  async function ensureDataFilter() {
    const found = resolveLayer('DataFilterExtension');
    if (found) return found;
    try {
      const mod = await loadDeckModule('@deck.gl/extensions');
      return (mod && mod.DataFilterExtension) || null;
    } catch (e) {
      console.warn('[TimelineAnimationWidget] could not load DataFilterExtension; ' +
                   'time-window layers filter rows on the CPU (no fade).', e);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Trips animator: comet over a historic trail, plus a current-position head.
  // ---------------------------------------------------------------------------

  // Windowed tangent around the cursor: returns a SMOOTHED heading (deg, 0 = north)
  // and the terrain slope as a pitch (deg, + = uphill in the direction of travel),
  // taken from the elevation (z) already baked into each [lon,lat,z] coordinate.
  // k = +/- fixes to span; larger k => smoother, laggier. k = 0 => single segment.
  function headTangent(C, j, last, k) {
    const ia = Math.max(0, j - k);
    const ib = Math.min(last, j + 1 + k);
    const a = C[ia], b = C[ib];
    if (!a || !b) return { heading: 0, pitch: 0, horiz: 0 };
    const midLat = (a[1] + b[1]) * 0.5 * Math.PI / 180;
    const dEastDeg  = (b[0] - a[0]) * Math.cos(midLat);
    const dNorthDeg = (b[1] - a[1]);
    const heading = (dEastDeg === 0 && dNorthDeg === 0)
      ? 0 : Math.atan2(dEastDeg, dNorthDeg) * 180 / Math.PI;
    const M_PER_DEG = 111320;
    const horiz = Math.hypot(dEastDeg, dNorthDeg) * M_PER_DEG;   // metres on the ground
    const dz = (b[2] || 0) - (a[2] || 0);                        // metres of climb/descent
    let pitch = (horiz > 0) ? Math.atan2(dz, horiz) * 180 / Math.PI : 0;
    const CAP = 20;                                              // never tip past +/-20deg
    if (pitch >  CAP) pitch =  CAP;
    if (pitch < -CAP) pitch = -CAP;
    return { heading: heading, pitch: pitch, horiz: horiz };
  }

  // Index j of the segment [T[j], T[j+1]] holding t. Starts from the last answer, so normal
  // playback is O(1); a jump (scrubbing, or the exporter starting mid-clip) is a binary search.
  function seek(T, t, j) {
    const last = T.length - 1;
    if (last < 1) return 0;
    if (!(j >= 0 && j < last)) j = 0;
    if (T[j] <= t && t <= T[j + 1]) return j;
    if (j + 2 <= last && T[j + 1] <= t && t <= T[j + 2]) return j + 1;
    let lo = 0, hi = last - 1;                       // last j with T[j] <= t
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function median(xs) {
    if (!xs.length) return 0;
    const s = xs.slice().sort(function (a, b) { return a - b; });
    return s[s.length >> 1];
  }

  // Centripetal Catmull-Rom point between p1 and p2 (u in [0,1]); centripetal so uneven fix
  // spacing never makes the curve loop or overshoot. Distances use cos(lat)-scaled degrees.
  function crPoint(p0, p1, p2, p3, u) {
    const kx = Math.cos(p1[1] * Math.PI / 180);
    function knot(a, b) { return Math.max(Math.sqrt(Math.hypot((b[0] - a[0]) * kx, b[1] - a[1])), 1e-9); }
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const t = t1 + (t2 - t1) * u;
    function lerp(a, b, ta, tb) {
      const w = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * w];
    }
    const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
    return lerp(lerp(A1, A2, t0, t2), lerp(A2, A3, t1, t3), t1, t2);
  }

  // One feature's track as the animator uses it: coordinates C and times T (curved if asked),
  // which segments are gaps, and the typical interval between fixes (for turn smoothing).
  function prepTrack(f, spec, subdiv) {
    const C0 = f.geometry && f.geometry.coordinates, T0s = f.timestamps;
    if (!C0 || !T0s || !C0.length) return null;
    const n = T0s.length, dts = [], lens = [];
    for (let j = 0; j + 1 < n; j++) {
      dts.push(T0s[j + 1] - T0s[j]);
      const kx = 111320 * Math.cos(C0[j][1] * Math.PI / 180);
      lens.push(Math.hypot((C0[j + 1][0] - C0[j][0]) * kx, (C0[j + 1][1] - C0[j][1]) * 110540));
    }
    const gap0 = dts.map(function (d) { return spec.gapS != null && d > spec.gapS ? 1 : 0; });
    const med = median(dts.filter(function (d, j) { return !gap0[j] && d > 0; }));
    const medLen = median(lens.filter(function (l, j) { return !gap0[j]; }));   // typical step between fixes
    if (!spec.curvePaths || subdiv < 2) return { C: C0, T: T0s, gap: gap0, med: med, medLen: medLen };
    const C = [C0[0]], T = [T0s[0]], gap = [];
    for (let j = 0; j + 1 < n; j++) {
      if (!gap0[j]) {                                    // curve within a run; never across a gap
        const p0 = (j > 0 && !gap0[j - 1]) ? C0[j - 1] : C0[j];
        const p3 = (j + 2 < n && !gap0[j + 1]) ? C0[j + 2] : C0[j + 1];
        for (let s = 1; s < subdiv; s++) {
          const u = s / subdiv;
          C.push(crPoint(p0, C0[j], C0[j + 1], p3, u));
          T.push(T0s[j] + u * dts[j]);
          gap.push(0);
        }
      }
      C.push(C0[j + 1]); T.push(T0s[j + 1]); gap.push(gap0[j]);
    }
    return { C: C, T: T, gap: gap, med: med, medLen: medLen };
  }

  // The trail rows drawn by the TripsLayer copies: each feature split at its gaps (so no line is
  // drawn across one), with curved coordinates if asked. Plain features pass through untouched.
  function trailRows(feats, tracks, spec) {
    const out = [];
    feats.forEach(function (f, i) {
      const tr = tracks[i];
      const hasGap = tr && tr.gap.some(function (g) { return g; });
      if (!tr || (!hasGap && tr.C === (f.geometry && f.geometry.coordinates))) { out.push(f); return; }
      let a = 0;
      for (let j = 0; j <= tr.gap.length; j++) {
        if (j < tr.gap.length && !tr.gap[j]) continue;
        if (j > a) {                                     // run of points a..j (>= 2 points)
          out.push(Object.assign({}, f, {
            geometry: Object.assign({}, f.geometry, { coordinates: tr.C.slice(a, j + 1) }),
            timestamps: tr.T.slice(a, j + 1),
          }));
        }
        a = j + 1;
      }
    });
    return out;
  }

  // Direction of travel around t from the NET movement over [t - W, t + W], each segment counted
  // by the share of it inside the window. It changes continuously with t (no snap at each fix)
  // and depends only on t, so the exported video matches the browser. Gaps are not crossed.
  function windowHeading(tr, j, t, W) {
    const C = tr.C, T = tr.T, last = T.length - 1;
    const lo = t - W, hi = t + W;
    const kx = 111320 * Math.cos(C[j][1] * Math.PI / 180), ky = 110540;
    let ex = 0, ny = 0, dz = 0;
    function add(s) {
      const a = T[s], b = T[s + 1], span = b - a;
      const w = span > 0 ? Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / span : 1;
      ex += (C[s + 1][0] - C[s][0]) * kx * w;
      ny += (C[s + 1][1] - C[s][1]) * ky * w;
      dz += ((C[s + 1][2] || 0) - (C[s][2] || 0)) * w;
    }
    add(j);
    for (let s = j - 1; s >= 0 && T[s + 1] > lo && !tr.gap[s]; s--) add(s);
    for (let s = j + 1; s < last && T[s] < hi && !tr.gap[s]; s++) add(s);
    const horiz = Math.hypot(ex, ny);
    const heading = horiz > 0 ? Math.atan2(ex, ny) * 180 / Math.PI : 0;
    const pitch = horiz > 0 ? Math.max(-20, Math.min(20, Math.atan2(dz, horiz) * 180 / Math.PI)) : 0;
    return { heading: heading, pitch: pitch, horiz: horiz };
  }

  const TURN_PLAYBACK_S = 0.1;   // playback seconds per unit of turn_smoothing, as a floor on the window

  // A feature's marker at time t: position, orientation and speed, or { gap } while t is inside a
  // data gap. When the subject is essentially stationary we HOLD the last good heading and zero
  // the pitch, so the model doesn't spin or tip over while milling in place (e.g. crop-raiding).
  function headAt(tr, i, t, st, head, spec) {
    if (!tr) return null;
    const C = tr.C, T = tr.T, last = T.length - 1;
    function orient(g) {
      if (g.horiz >= head.minMoveM) { st.lastHeading[i] = g.heading; return { heading: g.heading, pitch: g.pitch }; }
      return { heading: st.lastHeading[i] || 0, pitch: 0 };   // stationary: hold + level
    }
    function heading(j) {
      if (last < 1) return { heading: 0, pitch: 0, horiz: 0 };
      if (!spec.smoothTurning) return headTangent(C, j, last, head.smoothSamples);
      // While milling about, net movement over the window is GPS jitter with a random direction.
      // Widen the window until it holds a real step's worth of movement; else count as stationary.
      const enough = Math.max(head.minMoveM, 0.5 * tr.medLen);
      // At least TURN_PLAYBACK_S of playback either side too: on fast playback one frame spans
      // several fixes, and a window of a few fixes would still turn the marker on every frame.
      const playbackFloor = TURN_PLAYBACK_S * spec.turnSmoothing * maxTime / durationSec;
      let W = Math.max(tr.med * spec.turnSmoothing, playbackFloor, 1e-6), g = null;
      for (let k = 0; k < 4; k++, W *= 2) {
        g = windowHeading(tr, j, t, W);
        if (g.horiz >= enough) return g;
      }
      return { heading: g.heading, pitch: g.pitch, horiz: 0 };   // -> hold the last heading
    }
    if (t <= T[0] || last < 1) {
      const o = orient(heading(0));
      return { pos: C[0], heading: o.heading, pitch: o.pitch, speed: NaN };
    }
    if (t >= T[last]) {
      const o = orient(heading(last - 1));
      return { pos: C[last], heading: o.heading, pitch: o.pitch, speed: NaN };
    }
    const j = seek(T, t, st.cursors[i]);
    st.cursors[i] = j;
    const t0 = T[j], t1 = T[j + 1];
    if (tr.gap[j]) return { gap: true, pos: C[j], gapS: t1 - t0 };
    const f = (t1 > t0) ? (t - t0) / (t1 - t0) : 0;
    const a = C[j], b = C[j + 1];
    const az = a[2] || 0, bz = b[2] || 0;
    const pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, az + (bz - az) * f];
    const kx = 111320 * Math.cos(a[1] * Math.PI / 180);
    const metres = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
    const o = orient(heading(j));
    return { pos: pos, heading: o.heading, pitch: o.pitch, speed: t1 > t0 ? metres / (t1 - t0) * 3.6 : NaN };
  }

  // A feature's track colour, read through the TripsLayer's own getColor (column accessor,
  // function or constant) so the head matches whatever column the layer is coloured by.
  function trackColor(base, f, i) {
    const gc = base.props.getColor;
    let c = (typeof gc === 'function') ? gc(f, { index: i, data: base.props.data, target: [] }) : gc;
    if (Array.isArray(c) && Array.isArray(c[0])) c = c[0];   // per-vertex colours -> first vertex
    return Array.isArray(c) ? Array.from(c).slice(0, 3) : [255, 0, 0];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDuration(s) {
    const h = s / 3600;
    return h >= 48 ? (h / 24).toFixed(1) + ' d' : h >= 1 ? h.toFixed(1) + ' h' : Math.round(s / 60) + ' min';
  }

  // Markers at time t (st.heads) and the subjects currently inside a data gap (st.gapNow).
  function headData(base, st, spec, t) {
    const feats = base.props.data || [];
    const head = spec.head;
    const heads = [], gapNow = [];
    for (let i = 0; i < feats.length; i++) {
      const r = headAt(st.tracks[i], i, t, st, head, spec);
      if (!r) continue;
      const label = st.labels[i];
      if (r.gap) {
        gapNow.push({ position: r.pos, text: (label ? label + ' · ' : '') + 'no data ' + formatDuration(r.gapS) });
        continue;
      }
      const col = head.color || st.colors[i];
      const d = { position: r.pos, color: col, heading: r.heading, pitch: r.pitch, fi: i, label: label };
      if (spec.hoverInfo) {
        const name = st.tips[i] || ('Track ' + (i + 1));
        d.__tip = '<b>' + escapeHtml(name) + '</b><br>' + escapeHtml(formatTime(t)) +
                  (isFinite(r.speed) ? '<br>' + r.speed.toFixed(r.speed < 10 ? 1 : 0) + ' km/h' : '');
      }
      heads.push(d);
    }
    st.heads = heads;
    st.gapNow = gapNow;
    return heads;
  }

  // Pixel radius the pulse ring starts from: the dot's radius, or a fixed size for 3D models.
  function markerRadiusPx(head) {
    return (head.kind === 'dot' && head.dot.radiusUnits === 'pixels') ? head.dot.getRadius : 14;
  }

  // Pulse, label and gap layers drawn over the markers. All depend on t only (the pulse phase is
  // playback seconds), so a paused frame and an exported frame look the same.
  function decorLayers(base, st, spec, t) {
    const out = [];
    const heads = st.heads || [];
    if (spec.pulsePeriod && ScatterCtor && spec.head.kind !== 'none' && heads.length) {
      const playbackS = t / maxTime * durationSec;
      const phase = (playbackS / spec.pulsePeriod) % 1;
      out.push(new ScatterCtor({
        id: base.id + '-pulse',
        data: heads,
        getPosition: function (d) { return d.position; },
        getRadius: markerRadiusPx(spec.head),
        radiusUnits: 'pixels',
        radiusScale: 1.1 + 1.9 * phase,
        filled: false,
        stroked: true,
        getLineColor: function (d) { return d.color; },
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        opacity: 0.85 * (1 - phase),
        billboard: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { getPosition: t, getLineColor: 'head' },
      }));
    }
    if (LineCtor && st.gapLines.length) {
      const lines = st.gapLines.filter(function (g) { return g.t0 <= t; });   // once the gap has begun
      out.push(new LineCtor({
        id: base.id + '-gaps',
        data: lines,
        getSourcePosition: function (d) { return d.from; },
        getTargetPosition: function (d) { return d.to; },
        getColor: function (d) { return d.color; },
        getWidth: 1.5,
        widthUnits: 'pixels',
        opacity: 0.45,
        pickable: false,
      }));
    }
    if (TextCtor) {
      const texts = [];
      if (spec.labelCol) {
        heads.forEach(function (d) { if (d.label) texts.push({ position: d.position, text: d.label }); });
      }
      (st.gapNow || []).forEach(function (g) { texts.push({ position: g.position, text: g.text, gap: true }); });
      if (texts.length) {
        const lift = spec.head.kind === 'model' ? 44 : markerRadiusPx(spec.head) + 12;   // clear a 3D model's height
        out.push(new TextCtor({
          id: base.id + '-labels',
          data: texts,
          getPosition: function (d) { return d.position; },
          getText: function (d) { return d.text; },
          getSize: 12,
          sizeUnits: 'pixels',
          getPixelOffset: function (d) { return d.gap ? [0, 0] : [0, -lift]; },
          getColor: function (d) { return d.gap ? [235, 235, 235, 255] : [255, 255, 255, 255]; },
          background: true,
          getBackgroundColor: function (d) { return d.gap ? [90, 90, 90, 200] : [20, 20, 20, 185]; },
          backgroundPadding: [5, 3],
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          fontWeight: 600,
          characterSet: 'auto',
          billboard: true,
          pickable: false,
          parameters: { depthTest: false },
          updateTriggers: { getPosition: t, getText: t },
        }));
      }
    }
    return out;
  }

  function headLayer(base, st, spec, t) {
    const head = spec.head;
    const interactive = spec.hoverInfo || spec.clickToFollow;
    const onClick = spec.clickToFollow
      ? function (info) { if (info && info.object) { startFollow(base.id, info.object.fi); return true; } return false; }
      : null;
    if (head.kind === 'model' && ScenegraphCtor) {
      const m = head.model;
      return new ScenegraphCtor({
        id: base.id + '-head',
        data: headData(base, st, spec, t),
        scenegraph: m.uri,
        getPosition: function (d) { return d.position; },
        getOrientation: function (d) {
          const yaw = (m.faceHeading ? -d.heading : 0) + m.yawOffset;
          const pitch = m.pitch + (m.terrainPitch ? m.terrainScale * d.pitch : 0);
          return [pitch, yaw, m.roll];   // [pitch, yaw, roll] degrees
        },
        getColor: function (d) {
          return (m.useTrackColor && d.color) ? d.color : (m.tint || [255, 255, 255]);
        },
        sizeScale: m.size,
        sizeMinPixels: m.minPx,
        sizeMaxPixels: (m.maxPx == null) ? Number.MAX_SAFE_INTEGER : m.maxPx,
        _lighting: m.lighting,
        pickable: interactive,
        onClick: onClick,
        parameters: { depthTest: true },
        updateTriggers: { getPosition: t, getOrientation: t, getColor: 'head' },
      });
    }
    if (head.kind !== 'none' && ScatterCtor) {   // dot, or fallback while/if the model can't load
      return new ScatterCtor(Object.assign({}, head.dot, {
        id: base.id + '-head',
        data: headData(base, st, spec, t),
        getPosition: function (d) { return d.position; },
        getFillColor: function (d) { return d.color; },
        billboard: true,
        pickable: interactive,
        onClick: onClick,
        parameters: { depthTest: false },  // always visible over the terrain
        updateTriggers: { getPosition: t, getFillColor: 'head' },
      }));
    }
    headData(base, st, spec, t);   // no marker drawn, but labels, gap tags and follow still need positions
    return null;
  }

  // Time of one row of a time-window layer; GeoJsonLayer rows may nest it under properties.
  function rowTime(d) {
    if (d.__t !== undefined) return d.__t;
    return (d.properties && d.properties.__t !== undefined) ? d.properties.__t : NaN;
  }

  // Each animator: init(base, spec) -> state; build(base, spec, state, t) -> { layers, overlay }.
  // `layers` replace the base layer in place; `overlay` is drawn on top of everything.
  const ANIMATORS = {
    trips: {
      init: function (base, spec) {
        const feats = base.props.data || [];
        const n = feats.length;
        // Curved paths add (subdiv - 1) points per segment; cap the total so big layers stay fast.
        const points = feats.reduce(function (s, f) { return s + ((f.timestamps || []).length); }, 0);
        const subdiv = spec.curvePaths ? Math.max(1, Math.min(6, Math.floor(150000 / Math.max(points, 1)))) : 1;
        const tracks = feats.map(function (f) { return prepTrack(f, spec, subdiv); });
        const colors = feats.map(function (f, i) { return trackColor(base, f, i); });
        function col(name) {
          return feats.map(function (f) { const v = name ? f[name] : null; return v == null ? '' : String(v); });
        }
        // Faint lines across data gaps, in the history colour (or the track's colour without history).
        const gapLines = [];
        tracks.forEach(function (tr, i) {
          if (!tr) return;
          tr.gap.forEach(function (g, j) {
            if (g) gapLines.push({ from: tr.C[j], to: tr.C[j + 1], t0: tr.T[j],
                                   color: spec.showHistory ? spec.historyColor : colors[i] });
          });
        });
        return {
          cursors: new Array(n).fill(0), lastHeading: new Array(n).fill(0),
          tracks: tracks, colors: colors, labels: col(spec.labelCol), tips: col(spec.tipCol),
          trailData: trailRows(feats, tracks, spec), gapLines: gapLines, heads: [], gapNow: [],
        };
      },
      build: function (base, spec, st, t) {
        const layers = [];
        const data = st.trailData;   // split at gaps / curved; the same array every frame
        if (spec.showHistory) {
          // Inherit the comet's width from the TripsLayer (do NOT override getWidth).
          layers.push(base.clone({
            id: base.id + '-history',
            data: data,
            currentTime: t,
            trailLength: spec.historyTrail,
            fadeTrail: spec.fadeHistory,
            opacity: spec.historyOpacity,
            getColor: spec.historyColor,     // constant -> the whole track is this colour
            updateTriggers: { getColor: 'history' },
          }));
        }
        if (spec.glow) {   // the comet again, wider and faint, underneath it
          const p = base.props, k = spec.glow.width;
          layers.push(base.clone({
            id: base.id + '-glow',
            data: data,
            currentTime: t,
            trailLength: spec.cometTrail,
            fadeTrail: true,
            opacity: spec.glow.opacity,
            widthScale: (p.widthScale || 1) * k,
            widthMinPixels: (p.widthMinPixels || 0) * k,
            widthMaxPixels: (p.widthMaxPixels == null ? Number.MAX_SAFE_INTEGER : p.widthMaxPixels * k),
            pickable: false,
          }));
        }
        layers.push(base.clone({
          id: base.id + '-comet',
          data: data,
          currentTime: t,
          trailLength: spec.cometTrail,
          fadeTrail: true,
          opacity: 0.98,
        }));
        const head = headLayer(base, st, spec, t);
        const decor = decorLayers(base, st, spec, t);
        // pulse under the marker; labels and gap tags over it
        const pulse = decor.filter(function (l) { return /-pulse$/.test(l.id); });
        const rest = decor.filter(function (l) { return !/-pulse$/.test(l.id); });
        return { layers: layers, overlay: pulse.concat(head ? [head] : [], rest) };
      },
    },

    window: {
      init: function (base) { return { data: base.props.data || [], extensions: null }; },
      build: function (base, spec, st, t) {
        const lo = (spec.window == null) ? -1 : t - spec.window;   // the timeline starts at 0
        const gpu = DataFilterCtor && CPU_FILTER_LAYERS.indexOf(base.constructor.layerName) < 0;
        if (gpu) {
          // One extension instance for the layer's lifetime, or deck re-initialises it. The new
          // id makes deck create a fresh layer: an extension added to an existing layer never
          // gets its filter attribute, so every row would read as time 0.
          if (!st.extensions) {
            st.extensions = (base.props.extensions || []).concat([new DataFilterCtor({ filterSize: 1 })]);
          }
          return { layers: [base.clone({
            id: base.id + '-window',
            extensions: st.extensions,
            getFilterValue: rowTime,
            filterRange: [lo, t],
            filterSoftRange: [Math.min(lo + spec.fade, t), t],
          })], overlay: [] };
        }
        const rows = st.data.filter(function (d) { const v = rowTime(d); return v >= lo && v <= t; });
        return { layers: [base.clone({ data: rows })], overlay: [] };
      },
    },
  };

  function buildLayers() {
    const out = [], overlay = [];
    baseLayers.forEach(function (l) {
      const a = animatedById[l.id];
      if (!a) { out.push(l); return; }
      const built = a.animator.build(a.base, a.spec, a.state, currentTime);
      out.push.apply(out, built.layers);
      overlay.push.apply(overlay, built.overlay);
    });
    return out.concat(overlay);
  }

  function redraw() {
    if (destroyed) return;
    updateSun();   // deck reads the lights' props when it next draws
    if (animatedById) deck.setProps({ layers: buildLayers() });
    if (window.__camPreview) window.__camPreview(currentTime);   // Camera panel's preview drives the view
    followView();
    updateControls();
  }

  // ---------------------------------------------------------------------------
  // Sun lighting: one LightingEffect whose sun moves with the data time. Lit layers (the terrain,
  // 3D markers) are shaded by the real sun position over the map; ambient light sets the night level.
  // ---------------------------------------------------------------------------
  // deck.gl's default material reflects 35% of ambient and 60% of diffuse light, so scale the lights
  // for the terrain to come out at SUN.night of full brightness at night and ~DAY_LEVEL at midday.
  // SKY is the extra ambient light from a bright sky, from civil twilight up.
  const MAT_AMBIENT = 0.35, MAT_DIFFUSE = 0.6, DAY_LEVEL = 1.1, SKY = 0.12;
  const DEG = Math.PI / 180;
  let ambientLight = null, sunCenter = null;

  // Sun altitude and azimuth (radians; azimuth from north, clockwise) at epoch ms over lat/lon in
  // degrees. Low-precision solar ephemeris, good to well under a degree, which is plenty for shading.
  function solarPosition(ms, lat, lon) {
    const d = (ms - 946728000000) / 86400000;                 // days since J2000.0 (2000-01-01 12:00 UTC)
    const g = (357.529 + 0.98560028 * d) * DEG;               // mean anomaly
    const q = 280.459 + 0.98564736 * d;                       // mean longitude (deg)
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;   // ecliptic longitude
    const e = (23.439 - 0.00000036 * d) * DEG;                // obliquity
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) * 15; // Greenwich sidereal time (deg)
    const H = (gmst + lon) * DEG - ra;                        // hour angle
    const phi = lat * DEG;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
    return { alt: alt, az: az };
  }

  function smoothstep(a, b, x) {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  }

  // The sun light at timeline time t, averaged over SUN.smoothS seconds of playback either side so
  // day and night swell gently on fast playback instead of flashing. The averaged light vector gives
  // flat ground exactly the average of the instantaneous lighting. Depends only on t (video = browser).
  function sunAt(t) {
    const half = SUN.smoothS * maxTime / durationSec;          // data seconds either side
    const K = half > 0 ? 24 : 1;
    let vx = 0, vy = 0, vz = 0, sky = 0;
    for (let k = 0; k < K; k++) {
      const tt = K === 1 ? t : t - half + 2 * half * (k + 0.5) / K;
      const p = solarPosition((T0 + tt) * 1000, sunCenter[1], sunCenter[0]);
      const up = smoothstep(-2 * DEG, 2 * DEG, p.alt);          // soft sunrise / sunset edge
      const ca = Math.cos(p.alt);
      vx -= Math.sin(p.az) * ca * up;                            // the direction light travels
      vy -= Math.cos(p.az) * ca * up;
      vz -= Math.max(Math.sin(p.alt), 0.02) * up;
      sky += smoothstep(-6 * DEG, 4 * DEG, p.alt);               // civil twilight -> full sky light
    }
    vx /= K; vy /= K; vz /= K; sky /= K;
    const strength = Math.hypot(vx, vy, vz);
    const elev = strength > 0 ? Math.asin(-vz / strength) : 0;  // altitude of the averaged sun
    const warm = smoothstep(4 * DEG, 25 * DEG, elev);           // low sun is warm, high sun near white
    return {
      direction: strength > 0 ? [vx / strength, vy / strength, vz / strength] : [0, 0, -1],
      strength: strength,
      sky: sky,
      color: [255, Math.round(165 + 85 * warm), Math.round(105 + 135 * warm)],
    };
  }

  // When a whole day plays in under ~2.5 s, day and night can't be followed and averaging leaves a dull,
  // half-lit map; so the effect fades out as days get shorter, down to plain daylight below 0.8 s.
  const DAY_VISIBLE_S = [0.8, 2.5];
  const DAYLIGHT = { direction: [-0.35, -0.35, -0.87], strength: 1, sky: 1, color: [255, 250, 240] };

  function updateSun() {
    if (!sunLight) return;
    const secondsPerDay = 86400 * durationSec / maxTime;
    const v = smoothstep(DAY_VISIBLE_S[0], DAY_VISIBLE_S[1], secondsPerDay);
    const s = v > 0 ? sunAt(currentTime) : DAYLIGHT;
    function mix(a, b) { return a * v + b * (1 - v); }
    const dir = s.direction.map(function (x, i) { return mix(x, DAYLIGHT.direction[i]); });
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const night = Math.min(SUN.night, DAY_LEVEL);
    sunLight.direction = dir.map(function (x) { return x / len; });
    sunLight.color = s.color.map(function (c, i) { return Math.round(mix(c, DAYLIGHT.color[i])); });
    sunLight.intensity = mix(s.strength, 1) * Math.max(0, DAY_LEVEL - night - SKY) / MAT_DIFFUSE;
    ambientLight.intensity = (night + SKY * mix(s.sky, 1)) / MAT_AMBIENT;
  }

  function setupSun() {
    if (!SUN.on || !(T0 > 1e8)) return;   // needs epoch-second data times
    const Effect = resolveLayer('LightingEffect'), Ambient = resolveLayer('AmbientLight');
    const Directional = resolveLayer('DirectionalLight');
    if (!Effect || !Ambient || !Directional) {
      console.warn('[TimelineAnimationWidget] lighting classes unavailable in this deck.gl build; using default lighting.');
      return;
    }
    // The sun is placed over the middle of the data, not the camera, so a moving camera never changes it.
    let n = 0, lon = 0, lat = 0;
    Object.values(animatedById).forEach(function (a) {
      (a.state.tracks || []).forEach(function (tr) {
        if (tr && tr.C.length) { lon += tr.C[0][0]; lat += tr.C[0][1]; n++; }
      });
    });
    const v = currentView() || {};
    sunCenter = n ? [lon / n, lat / n] : [v.longitude || 0, v.latitude || 0];
    sunLight = new Directional({ color: [255, 250, 240], intensity: 1, direction: [0, 0, -1] });
    ambientLight = new Ambient({ color: [255, 255, 255], intensity: 1 });
    updateSun();
    deck.setProps({ effects: [new Effect({ ambient: ambientLight, sun: sunLight })] });
  }

  // ---------------------------------------------------------------------------
  // Click to follow: the camera keeps the clicked marker centred. Dragging the map, clicking
  // anywhere else or Esc stops it. Interactive only: the exporter never clicks.
  // ---------------------------------------------------------------------------
  function currentView() {
    try {
      const v = deck.getViewports()[0];
      return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing };
    } catch (e) { return _deckViewState; }
  }

  function startFollow(layerId, fi) {
    following = { layerId: layerId, fi: fi };
    followView();
  }

  function stopFollow() { following = null; }

  function followView() {
    if (!following || window.__camPreviewOn || !animatedById) return;
    const a = animatedById[following.layerId];
    const h = a && (a.state.heads || []).find(function (d) { return d.fi === following.fi; });
    if (!h) return;                                  // inside a data gap: hold the camera
    const v = _deckViewState || currentView();
    if (!v) return;
    _deckViewState = Object.assign({}, v, { longitude: h.position[0], latitude: h.position[1] });
    if (autoRotateSpeed === 0) deck.setProps({ viewState: _deckViewState });
    // with auto-rotation on, frame() applies _deckViewState together with the bearing
  }

  // Hand the camera back to the viewer at `view`, e.g. when the Camera panel's preview ends.
  function releaseCamera(view) {
    if (!view) return;
    if (autoRotateSpeed !== 0) {
      _deckViewState = Object.assign({}, view);
      rotateBearing  = view.bearing || 0;
      deck.setProps({ viewState: _deckViewState });
    } else {
      deck.setProps({ viewState: null, initialViewState: Object.assign({}, view) });
    }
  }

  // ---------------------------------------------------------------------------
  // Playback bar, configured by PlaybackControls (CONTROLS). Absent parts stay null.
  // ---------------------------------------------------------------------------
  let controls = null;   // { root, play, slider, label, clock, speed }
  const SPEEDS = CONTROLS.speeds;
  let playbackRate = 1;  // viewer's speed multiplier on top of durationSec (not used by the exporter)

  function formatClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function formatTime(t) {
    if (CONTROLS.time_format !== 'elapsed' && T0 > 1e8) {   // epoch seconds -> real date, at the UTC offset
      const off = CONTROLS.utc_offset_hours || 0;
      const iso = new Date((T0 + t + off * 3600) * 1000).toISOString();
      if (CONTROLS.time_format === 'date') return iso.slice(0, 10);
      const m = Math.round(Math.abs(off) * 60);
      const zone = off === 0 ? 'UTC' : 'UTC' + (off < 0 ? '−' : '+') + Math.floor(m / 60) +
                   (m % 60 ? ':' + String(m % 60).padStart(2, '0') : '');
      return iso.slice(0, 16).replace('T', ' ') + ' ' + zone;
    }
    const h = t / 3600;  // elapsed since the start
    return h >= 48 ? (h / 24).toFixed(1) + ' d' : h.toFixed(1) + ' h';
  }

  function setPlaying(on) {
    if (on && currentTime >= maxTime) currentTime = 0;   // play at the end -> start over
    if (on && !isPlaying) { isPlaying = true; lastTickTs = null; requestAnimationFrame(frame); }
    if (!on) isPlaying = false;
    updateControls();
  }

  function updateControls() {
    if (!controls) return;
    if (controls.play) {
      controls.play.textContent = isPlaying ? '❚❚' : '▶';
      controls.play.title = isPlaying ? 'Pause' : 'Play';
    }
    if (controls.slider && document.activeElement !== controls.slider) controls.slider.value = currentTime;
    if (controls.label) controls.label.textContent = formatTime(currentTime);
    if (controls.clock) {   // playback position / total length, at the current speed
      const total = durationSec / playbackRate;
      controls.clock.textContent = formatClock(total * currentTime / maxTime) + ' / ' + formatClock(total);
    }
    if (controls.speed) controls.speed.textContent = playbackRate + '×';
  }

  function buildControls() {
    const root = document.createElement('div');
    root.id = 'timeline-controls';
    // Bottom: above the corner widgets (scale bar left, legend right). Top: below the title.
    const edge = CONTROLS.position === 'top' ? 'top:56px;' : 'bottom:72px;';
    root.style.cssText = 'position:absolute;left:50%;' + edge + 'transform:translateX(-50%);z-index:10;' +
      'display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;' +
      'background:rgba(20,20,20,0.72);color:#fff;font:12px/1.2 system-ui,sans-serif;' +
      'max-width:min(640px,calc(100% - 32px));box-sizing:border-box;';
    if (CONTROLS.show_scrubber) root.style.width = 'min(640px,calc(100% - 32px))';
    function button(text, title, onClick) {
      const b = document.createElement('button');
      b.textContent = text; b.title = title;
      b.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font-size:14px;padding:2px 4px;';
      b.addEventListener('click', onClick);
      root.appendChild(b);
      return b;
    }
    function text(title) {
      const s = document.createElement('span');
      s.title = title;
      s.style.cssText = 'white-space:nowrap;font-variant-numeric:tabular-nums;';
      root.appendChild(s);
      return s;
    }
    const c = { root: root, play: null, slider: null, label: null, clock: null, speed: null };
    if (CONTROLS.show_play) c.play = button('', 'Pause', function () { setPlaying(!isPlaying); });
    if (CONTROLS.show_restart) {
      button('↺', 'Restart', function () { currentTime = 0; lastTickTs = null; redraw(); setPlaying(true); });
    }
    if (CONTROLS.show_scrubber) {
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = 0; slider.max = maxTime; slider.step = maxTime / 1000;
      slider.style.cssText = 'flex:1;min-width:60px;accent-color:#fff;';
      slider.addEventListener('input', function () {
        currentTime = Number(slider.value); lastTickTs = null; redraw();
      });
      root.appendChild(slider);
      c.slider = slider;
    }
    if (CONTROLS.show_clock) {
      c.clock = text('Playback position / total length at this speed');
      c.clock.style.opacity = '0.75';
    }
    if (CONTROLS.show_time) c.label = text('Current time in the data');
    if (CONTROLS.show_camera) {
      button('🎥', 'Camera: design and preview the video camera', function () {
        if (window.__camPanel) window.__camPanel.toggle();
      });
    }
    if (CONTROLS.show_speed) {
      c.speed = button('', 'Playback speed', function () {
        playbackRate = SPEEDS[(SPEEDS.indexOf(playbackRate) + 1) % SPEEDS.length];
        updateControls();
      });
      c.speed.style.minWidth = '34px';
    }
    if (!root.children.length) return;   // every part switched off
    document.body.appendChild(root);
    controls = c;
    updateControls();
  }

  function frame(timestamp) {
    if (!isPlaying || destroyed) return;

    if (!timestamp) timestamp = 0;
    // Frame cap that holds an even cadence: a frame slightly early (display timing jitter) counts as
    // on time, and lateness is carried into the next interval. A strict `< fpsInterval` check skips
    // every early refresh, e.g. only ~38 fps with a 60 fps cap on a 60 Hz display (stutter).
    const sinceLast = timestamp - lastFrameTime;
    if (sinceLast < fpsInterval - Math.min(4, fpsInterval * 0.15)) {
      requestAnimationFrame(frame);
      return;
    }
    const late = sinceLast - fpsInterval;
    lastFrameTime = late > fpsInterval * 3 ? timestamp : timestamp - Math.max(0, late % fpsInterval);

    // Advance by elapsed wall time so playback lasts durationSec whatever the frame rate.
    const dt = lastTickTs === null ? 0 : timestamp - lastTickTs;
    lastTickTs = timestamp;
    if (currentTime < maxTime) {
      currentTime = Math.min(maxTime, currentTime + dt * timePerMs * playbackRate);
    } else {
      setPlaying(false);        // Stop animation at the end
    }

    redraw();

    if (autoRotateSpeed !== 0 && _deckViewState && !window.__camPreviewOn) {
      const rdt = lastRotateTs ? (timestamp - lastRotateTs) : 0;
      lastRotateTs = timestamp;
      if (!userInteracting) rotateBearing = (rotateBearing + autoRotateSpeed * rdt / 1000) % 360;
      deck.setProps({ viewState: Object.assign({}, _deckViewState, { bearing: rotateBearing }) });
    }

    requestAnimationFrame(frame);
  }

  function onEscape(e) { if (e.key === 'Escape') stopFollow(); }

  function start() {
    baseLayers = deck.props.layers;
    animatedById = {};
    LAYER_SPECS.forEach(function (spec) {
      const base = baseLayers.find(function (l) { return l && l.id === spec.id; });
      if (!base) { console.warn('[TimelineAnimationWidget] animated layer not found: ' + spec.id); return; }
      const animator = ANIMATORS[spec.kind];
      animatedById[spec.id] = { base: base, spec: spec, animator: animator, state: animator.init(base, spec) };
    });

    // Rotation and following make the camera controlled (frame()/followView() set viewState), so
    // deck stops applying user input by itself: apply every pan/zoom/rotate here immediately,
    // resume auto-rotation from the user's bearing, and hold it while they are dragging.
    // Dragging the map also stops following.
    const canFollow = LAYER_SPECS.some(function (s) { return s.kind === 'trips' && s.clickToFollow; });
    if (autoRotateSpeed !== 0 || canFollow) {
      const ivs = deck.props && deck.props.initialViewState;
      if (ivs) {
        _deckViewState = Object.assign({}, ivs);
        rotateBearing  = _deckViewState.bearing || 0;
      }
      const _origOnVS = deck.props.onViewStateChange;
      deck.setProps({
        onViewStateChange: function (params) {
          if (window.__camPreviewOn) return;   // the Camera panel's preview owns the view
          const s = params.interactionState || {};
          userInteracting = !!(s.isDragging || s.isPanning || s.isRotating || s.isZooming);
          if (following && (s.isDragging || s.isPanning)) stopFollow();
          _deckViewState = params.viewState;
          rotateBearing  = params.viewState.bearing || 0;
          deck.setProps({ viewState: _deckViewState });
          if (following) followView();          // zooming while following stays centred
          if (_origOnVS) _origOnVS(params);
        }
      });
    }
    if (canFollow) {
      // A click that no marker handled (empty map, other layers) stops following; so does Esc.
      const _origOnClick = deck.props.onClick;
      deck.setProps({
        onClick: function (info, event) {
          if (following) stopFollow();
          if (_origOnClick) return _origOnClick(info, event);
        }
      });
      document.addEventListener('keydown', onEscape);
    }
    if (LAYER_SPECS.some(function (s) { return s.kind === 'trips' && s.hoverInfo; })) {
      // Markers carry their own tooltip HTML (__tip); anything else keeps the map's tooltip.
      const _origTip = deck.props.getTooltip;
      deck.setProps({
        getTooltip: function (info) {
          const o = info && info.object;
          if (o && o.__tip) {
            return { html: o.__tip, style: { background: 'rgba(20,20,20,0.85)', color: '#fff', fontSize: '12px',
                                             padding: '6px 8px', borderRadius: '6px', lineHeight: '1.35' } };
          }
          return _origTip ? _origTip(info) : null;
        }
      });
    }

    TextCtor = resolveLayer('TextLayer');
    LineCtor = resolveLayer('LineLayer');
    setupSun();

    if (needsDot) {
      ScatterCtor = resolveLayer('ScatterplotLayer');
      if (!ScatterCtor) {
        console.warn('[TimelineAnimationWidget] ScatterplotLayer constructor not found; ' +
                     '2D head marker disabled. Trail animation is unaffected.');
      }
    }
    if (needsModel) {
      ensureScenegraph().then(function (C) { ScenegraphCtor = C; __headReady = true; redraw(); });
    }
    if (needsFilter) {
      ensureDataFilter().then(function (C) { DataFilterCtor = C; __filterReady = true; redraw(); });
    }

    if (CONTROLS.visible) buildControls();
    requestAnimationFrame(frame);
  }

  // Start once pydeck's JSON conversion has handed deck its layers.
  const startTimer = setInterval(function () {
    if (!(deck.props && deck.props.layers)) return;
    clearInterval(startTimer);
    start();
  }, 200);

  // --- Deterministic render bridge (used by the server-side MP4 exporter) ---------
  // Lets a headless driver pause autoplay and paint an exact frame at time t.
  const bridge = {
    get ready()    { return !!animatedById; },
    // Every lazily loaded piece (3D head model, DataFilterExtension) is in place.
    get headReady() { return __headReady && __filterReady; },
    get span()     { return maxTime; },
    get durationSec() { return durationSec; },
    get specs()    { return LAYER_SPECS; },  // animated layers (id, kind, window), for the exporter's camera
    get time()     { return currentTime; },
    pause() { setPlaying(false); },
    setView(view) { releaseCamera(view); },
    play()  { setPlaying(true); },
    renderAt(t) {
      isPlaying = false;
      currentTime = Math.max(0, Math.min(maxTime, t));
      redraw();
    }
  };
  window.__tripsAnim = bridge;

  return {
    destroy: function () {
      destroyed = true;
      isPlaying = false;
      clearInterval(startTimer);
      document.removeEventListener('keydown', onEscape);
      if (controls) controls.root.remove();
      controls = null;
      if (window.__tripsAnim === bridge) delete window.__tripsAnim;
    }
  };
}
