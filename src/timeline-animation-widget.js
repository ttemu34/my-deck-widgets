// A deck.gl Widget that animates any number of layers from one shared clock: the
// engine behind ecoscope-workflows-ext-mep's draw_animated_map.
//
// Each entry of `layerSpecs` names a layer (by id) and an animator kind; ANIMATORS
// turns the base layer + current time into the layers actually drawn this frame:
//
// - 'trips': a TripsLayer becomes a comet over a historic trail (+ optional glow),
//   with a head marker (dot or glTF model), pulse ring, labels, hover tooltips and
//   click-to-follow. Across a data gap the trail breaks and the marker is hidden.
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

import { Widget, WebMercatorViewport } from '@deck.gl/core';

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
  // Adaptive speed: quiet stretches (every subject below restKmh, or night) play maxSpeedup x faster.
  pacing: { adaptive: false, maxSpeedup: 6, restKmh: 0.5, night: false },
  easeS: 0,              // seconds to ease playback speed changes (interactive only)
  followSmoothingS: 0,   // seconds for the camera to catch up with a followed marker; 0 = locked on
  fitView: null,         // { padding, maxZoom }: open framed on the animated tracks at the map's size
  controls: { visible: false }  // PlaybackControls, snake_case keys as dumped by pydantic
};

function createTimeline(deck, props) {
  const LAYER_SPECS     = props.layerSpecs;
  const maxTime         = props.maxTime;
  const T0              = props.t0;
  const CONTROLS        = props.controls;
  const durationSec     = props.durationS;
  const fpsInterval     = 1000 / props.fpsLimit;
  const autoRotateSpeed = props.autoRotateSpeed;
  const SUN             = props.sun;                     // { on, night, smoothS }: sun lighting at the data time
  const PACING          = props.pacing || TimelineAnimationWidget.defaultProps.pacing;
  const EASE_S          = props.easeS || 0;
  const FOLLOW_S        = props.followSmoothingS || 0;
  const CPU_FILTER_LAYERS = ['HexagonLayer'];            // aggregation layers: filter rows, not on the GPU
  // The comet's speed colours, slow -> fast (blue, teal, yellow, orange, red).
  const SPEED_RAMP = [[45, 95, 220], [40, 185, 200], [250, 220, 70], [245, 125, 40], [215, 40, 40]];
  const DAY_COLOR = [255, 205, 110], NIGHT_COLOR = [85, 110, 235];
  const RUN_FACTOR = 2.5;   // faster than this many times its typical speed -> the run animation
  // A headless browser (the video exporter) paints exact frames, so 3D-model animations follow the
  // playback time there instead of the wall clock.
  const headless = typeof navigator !== 'undefined' && !!navigator.webdriver;

  let currentTime   = 0;     // timeline (data) time, seconds since t0
  let progress      = 0;     // playback position 0..1; equals currentTime / maxTime without adaptive speed
  let effRate       = 0;     // eased playback rate actually applied (0 at load, so playback eases in)
  let pausing       = false; // easing down to a stop
  let isPlaying     = false; // autoplay starts once the map has loaded (waitForMap)
  let loadingMap    = true;  // waiting for the base map and tiles before autoplay
  let autoplayOff   = false; // the viewer (or the exporter) took control while the map was loading
  let labelsOn      = true;  // marker labels (the exporter can switch them off for a video)
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
  let TextCtor  = null;      // marker labels
  let sunLight  = null;      // DirectionalLight that sunAt() moves with the clock (SUN.on)
  let shadowSun = null;      // { direction, strength } of the current sun, for 3D-marker shadows
  let following = null;      // { layerId, fi }: the marker the camera follows (click_to_follow)
  let followCenter = null, followTs = 0, followRaf = 0;   // the eased camera centre while following
  let deckTimeline = null;   // deck's own Timeline, which drives 3D-model animations
  let pace = null;           // adaptive-speed table (buildPacing); null -> playback is linear in data time

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

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  // Speed (km/h) over segment j of a prepared track.
  function segKmh(tr, j) {
    const a = tr.C[j], b = tr.C[j + 1], dt = tr.T[j + 1] - tr.T[j];
    if (!(dt > 0)) return NaN;
    const kx = 111320 * Math.cos(a[1] * Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540) / dt * 3.6;
  }

  // ---------------------------------------------------------------------------
  // Pacing: playback progress (0..1) <-> timeline time. Without adaptive speed it's linear. With it,
  // each moment gets playback time in proportion to a weight: 1 while any subject moves, 1/maxSpeedup
  // while all rest (or at night), softened so the speed swells rather than jumps. Everything that
  // depends on playback (pulse phase, turn and sun smoothing, the clock, the exporter's frame times)
  // goes through these, so the video and the map stay in step.
  // ---------------------------------------------------------------------------
  function boxBlur(w, R) {
    const n = w.length, out = new Float64Array(n);
    let s = 0;
    for (let k = -R; k <= R; k++) s += w[Math.max(0, Math.min(n - 1, k))];
    for (let b = 0; b < n; b++) {
      out[b] = s / (2 * R + 1);
      s += w[Math.min(n - 1, b + R + 1)] - w[Math.max(0, b - R)];
    }
    return out;
  }

  function buildPacing() {
    pace = null;
    if (!PACING.adaptive || !(maxTime > 0) || !(PACING.maxSpeedup > 1)) return;
    const N = 2048, bw = maxTime / N, act = new Float64Array(N);
    let any = false;
    Object.values(animatedById).forEach(function (a) {
      if (a.spec.kind !== 'trips') return;
      (a.state.tracks || []).forEach(function (tr) {
        if (!tr) return;
        for (let j = 0; j + 1 < tr.T.length; j++) {
          if (tr.gap[j] || !(segKmh(tr, j) >= PACING.restKmh)) continue;   // gaps and rest stay quiet
          const b0 = Math.max(0, Math.floor(tr.T[j] / bw)), b1 = Math.min(N - 1, Math.floor(tr.T[j + 1] / bw));
          for (let b = b0; b <= b1; b++) act[b] = 1;
          any = true;
        }
      });
    });
    if (!any) return;                                     // nothing ever moves: keep linear playback
    const c = PACING.night && T0 > 1e8 ? dataCenter() : null;
    if (c) {
      for (let b = 0; b < N; b++) {
        if (solarPosition((T0 + (b + 0.5) * bw) * 1000, c[1], c[0]).alt < -6 * DEG) act[b] = 0;
      }
    }
    const q = 1 / PACING.maxSpeedup;
    const R = Math.max(1, Math.round(N * 0.015));          // ~1.5% of the clip either side
    const w = boxBlur(boxBlur(Array.from(act, function (x) { return q + (1 - q) * x; }), R), R);
    const cum = new Float64Array(N + 1);
    for (let b = 0; b < N; b++) cum[b + 1] = cum[b] + w[b];
    pace = { N: N, bw: bw, cum: cum, total: cum[N] };
  }

  function progressAt(t) {
    if (!pace) return clamp01(t / maxTime);
    const x = Math.max(0, Math.min(pace.N, t / pace.bw)), b = Math.min(pace.N - 1, Math.floor(x));
    return (pace.cum[b] + (x - b) * (pace.cum[b + 1] - pace.cum[b])) / pace.total;
  }

  function timeAt(p) {
    if (!pace) return clamp01(p) * maxTime;
    const c = clamp01(p) * pace.total, cum = pace.cum;
    let lo = 0, hi = pace.N - 1;                          // last bin b with cum[b] <= c
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= c) lo = mid; else hi = mid - 1; }
    const w = cum[lo + 1] - cum[lo];
    return (lo + (w > 0 ? (c - cum[lo]) / w : 0)) * pace.bw;
  }

  // Data seconds that play per playback second, at time t.
  function dataRate(t) {
    if (!pace) return maxTime / durationSec;
    const b = Math.max(0, Math.min(pace.N - 1, Math.floor(t / pace.bw)));
    return pace.total * pace.bw / (durationSec * (pace.cum[b + 1] - pace.cum[b]));
  }

  // The middle of the animated data (first fix of each track), for the sun and night pacing.
  function dataCenter() {
    let n = 0, lon = 0, lat = 0;
    Object.values(animatedById || {}).forEach(function (a) {
      (a.state.tracks || []).forEach(function (tr) {
        if (tr && tr.C.length) { lon += tr.C[0][0]; lat += tr.C[0][1]; n++; }
      });
    });
    if (n) return [lon / n, lat / n];
    const v = currentView();
    return v ? [v.longitude || 0, v.latitude || 0] : null;
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
  // A segment is a gap if it is longer than spec.gapS or listed in the feature's `breaks`
  // (stretches removed upstream, e.g. by a trajectory segment filter): never glide across those.
  function prepTrack(f, spec, subdiv) {
    const C0 = f.geometry && f.geometry.coordinates, T0s = f.timestamps;
    if (!C0 || !T0s || !C0.length) return null;
    const breaks = new Set(Array.isArray(f.breaks) ? f.breaks : []);
    const n = T0s.length, dts = [], lens = [];
    for (let j = 0; j + 1 < n; j++) {
      dts.push(T0s[j + 1] - T0s[j]);
      const kx = 111320 * Math.cos(C0[j][1] * Math.PI / 180);
      lens.push(Math.hypot((C0[j + 1][0] - C0[j][0]) * kx, (C0[j + 1][1] - C0[j][1]) * 110540));
    }
    const gap0 = dts.map(function (d, j) { return breaks.has(j) || (spec.gapS != null && d > spec.gapS) ? 1 : 0; });
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

  // A feature's marker at time t: position, orientation and speed, or null while t is inside a
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
      const playbackFloor = TURN_PLAYBACK_S * spec.turnSmoothing * dataRate(t);
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
    if (tr.gap[j]) return null;   // inside a data gap: no marker
    const f = (t1 > t0) ? (t - t0) / (t1 - t0) : 0;
    const a = C[j], b = C[j + 1];
    const az = a[2] || 0, bz = b[2] || 0;
    const pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, az + (bz - az) * f];
    const kx = 111320 * Math.cos(a[1] * Math.PI / 180);
    const metres = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
    const o = orient(heading(j));
    return { pos: pos, heading: o.heading, pitch: o.pitch, speed: t1 > t0 ? metres / (t1 - t0) * 3.6 : NaN };
  }

  // How a marker responds to its speed: `move` 0 (resting) .. 1 (moving), `fast` 0 .. 1 above its
  // typical speed, the dot `scale`, and the 3D model's animation `state`. Smooth in speed, so a
  // marker never flickers between sizes.
  function speedLook(speed, st, spec) {
    if (!spec.speedResponse) return { move: 1, fast: 0, scale: 1, state: 'walk' };
    const rest = PACING.restKmh, typ = Math.max(st.typKmh || 0, rest * 2, 1e-3);
    const v = isFinite(speed) ? speed : 0;
    const move = smoothstep(rest * 0.5, Math.max(rest * 1.5, typ * 0.5), v);
    const fast = smoothstep(typ * 1.5, typ * 3, v);
    const state = v >= typ * RUN_FACTOR ? 'run' : move > 0.5 ? 'walk' : 'idle';
    return { move: move, fast: fast, scale: 0.78 + 0.22 * move + 0.15 * fast, state: state };
  }

  // Per-vertex comet colours for each trail row: by speed (ramp scaled to the layer's 95th-percentile
  // moving speed) or by day / night (sun altitude at each fix). null -> the track's own colour.
  function vertexColors(rows, spec, st) {
    if (spec.cometColor === 'speed') {
      const top = Math.max(st.p95Kmh || 0, PACING.restKmh * 4, 1e-3);
      return rows.map(function (r) {
        const C = r.geometry.coordinates, T = r.timestamps, out = [];
        for (let k = 0; k < C.length; k++) {
          const s = Math.max(0, k - 1), e = Math.min(C.length - 1, s + 1);
          const dt = T[e] - T[s], kx = 111320 * Math.cos(C[s][1] * Math.PI / 180);
          const v = dt > 0 ? Math.hypot((C[e][0] - C[s][0]) * kx, (C[e][1] - C[s][1]) * 110540) / dt * 3.6 : 0;
          out.push(rampColor(SPEED_RAMP, clamp01(v / top)));
        }
        return out;
      });
    }
    if (spec.cometColor === 'day_night' && T0 > 1e8) {
      return rows.map(function (r) {
        const C = r.geometry.coordinates, T = r.timestamps;
        return C.map(function (p, k) {
          const w = smoothstep(-6 * DEG, 4 * DEG, solarPosition((T0 + T[k]) * 1000, p[1], p[0]).alt);
          return NIGHT_COLOR.map(function (n, i) { return Math.round(n + (DAY_COLOR[i] - n) * w); });
        });
      });
    }
    return null;
  }

  function rampColor(stops, u) {
    const x = u * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return stops[i].map(function (c, k) { return Math.round(c + (stops[i + 1][k] - c) * f); });
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

  // Markers at time t (st.heads). A subject inside a data gap has no marker until its data resumes.
  function headData(base, st, spec, t) {
    const feats = base.props.data || [];
    const head = spec.head;
    const heads = [];
    for (let i = 0; i < feats.length; i++) {
      const r = headAt(st.tracks[i], i, t, st, head, spec);
      if (!r) continue;
      const label = st.labels[i];
      const col = head.color || st.colors[i];
      const look = speedLook(r.speed, st, spec);
      const d = { position: r.pos, color: col, heading: r.heading, pitch: r.pitch, fi: i, label: label,
                  move: look.move, scale: look.scale, state: look.state };
      if (spec.hoverInfo) {
        const name = st.tips[i] || ('Track ' + (i + 1));
        d.__tip = '<b>' + escapeHtml(name) + '</b><br>' + escapeHtml(formatTime(t)) +
                  (isFinite(r.speed) ? '<br>' + r.speed.toFixed(r.speed < 10 ? 1 : 0) + ' km/h' : '');
      }
      heads.push(d);
    }
    st.heads = heads;
    return heads;
  }

  // Pixel radius the pulse ring starts from: the dot's radius, or a fixed size for 3D models.
  function markerRadiusPx(head) {
    return (head.kind === 'dot' && head.dot.radiusUnits === 'pixels') ? head.dot.getRadius : 14;
  }

  // Pulse and label layers drawn over the markers. All depend on t only (the pulse phase is
  // playback seconds), so a paused frame and an exported frame look the same.
  function decorLayers(base, st, spec, t) {
    const out = [];
    const heads = st.heads || [];
    if (spec.pulsePeriod && ScatterCtor && spec.head.kind !== 'none' && heads.length) {
      const playbackS = progressAt(t) * durationSec;
      const phase = (playbackS / spec.pulsePeriod) % 1;
      const r0 = markerRadiusPx(spec.head), grow = 1.1 + 1.9 * phase, alpha = 0.85 * (1 - phase) * 255;
      out.push(new ScatterCtor({
        id: base.id + '-pulse',
        data: heads,
        getPosition: function (d) { return d.position; },
        getRadius: function (d) { return r0 * d.scale * grow; },
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        // A resting subject stops pulsing (speed response); the ring fades as it grows.
        getLineColor: function (d) { return [d.color[0], d.color[1], d.color[2], Math.round(alpha * d.move)]; },
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        billboard: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { getPosition: t, getRadius: t, getLineColor: t },
      }));
    }
    if (TextCtor) {
      const texts = [];
      if (spec.labelCol && labelsOn) {
        heads.forEach(function (d) { if (d.label) texts.push({ position: d.position, text: d.label }); });
      }
      if (texts.length) {
        const lift = spec.head.kind === 'model' ? 44 : markerRadiusPx(spec.head) + 12;   // clear a 3D model's height
        out.push(new TextCtor({
          id: base.id + '-labels',
          data: texts,
          getPosition: function (d) { return d.position; },
          getText: function (d) { return d.text; },
          getSize: 12,
          sizeUnits: 'pixels',
          getPixelOffset: [0, -lift],
          getColor: [255, 255, 255, 255],
          background: true,
          getBackgroundColor: [20, 20, 20, 185],
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

  // Soft shadow under 3D models: two dark discs on the ground, pushed away from the sun and fainter
  // when it's low or down. Sized like the model, within its own pixel limits.
  function shadowLayers(base, spec, heads) {
    const m = spec.head.model, r = m.size * 0.3;          // metres
    let ox = 0, oy = 0, a = 1;
    if (shadowSun) {
      const d = shadowSun.direction, k = Math.min(1.5, 0.6 / Math.max(0.3, Math.abs(d[2])));
      ox = d[0] * r * k; oy = d[1] * r * k;
      a = 0.25 + 0.75 * clamp01(shadowSun.strength);
    }
    function at(d) {
      const p = d.position, kx = 111320 * Math.cos(p[1] * Math.PI / 180);
      return [p[0] + ox / kx, p[1] + oy / 110540, p[2] || 0];
    }
    const maxPx = m.maxPx == null ? 400 : m.maxPx;
    const t = currentTime;
    return [[1, 38], [0.55, 52]].map(function (ring, i) {
      return new ScatterCtor({
        id: base.id + '-shadow-' + i,
        data: heads,
        getPosition: at,
        getRadius: r * ring[0],
        radiusUnits: 'meters',
        radiusMinPixels: m.minPx * 0.35 * ring[0],
        radiusMaxPixels: maxPx * 0.35 * ring[0],
        getFillColor: [0, 0, 0, Math.round(ring[1] * a)],
        stroked: false,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { getPosition: t },
      });
    });
  }

  // The `_animations` prop for one animation state, cached so deck only re-applies it on a change.
  // Interactively the walk cycle runs on deck's own clock at the playback speed and stops on pause;
  // in the headless exporter deck's clock is set to the playback time instead (renderAt).
  function animationsProp(st, key, speed) {
    if (key == null) return undefined;
    const playing = headless || (isPlaying && !pausing);
    const rate = headless ? speed : speed * playbackRate;
    const id = key + '|' + playing + '|' + rate;
    if (!st.anims[id]) {
      // Every clip defaults to playing, so stop them all ('*' is applied first: keys go in sorted order)
      // and run only this one.
      const o = { '*': { playing: false } };
      o[key] = { playing: playing, speed: rate };
      st.anims[id] = o;
    }
    return st.anims[id];
  }

  function headLayers(base, st, spec, t) {
    const head = spec.head;
    const interactive = spec.hoverInfo || spec.clickToFollow;
    const onClick = spec.clickToFollow
      ? function (info) { if (info && info.object) { startFollow(base.id, info.object.fi); return true; } return false; }
      : null;
    if (head.kind === 'model' && ScenegraphCtor) {
      const m = head.model, heads = headData(base, st, spec, t), out = [];
      if (spec.shadow && ScatterCtor && heads.length) out.push.apply(out, shadowLayers(base, spec, heads));
      const anims = m.anims || {};
      const animated = spec.speedResponse && (anims.walk != null || anims.idle != null);
      // One layer per animation state (each plays its own clip); without animations, one layer.
      const groups = animated ? ['idle', 'walk', 'run'] : ['all'];
      groups.forEach(function (g) {
        out.push(new ScenegraphCtor({
          id: base.id + '-head' + (g === 'all' ? '' : '-' + g),
          data: g === 'all' ? heads : heads.filter(function (d) { return d.state === g; }),
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
          _animations: g === 'all' ? undefined : animationsProp(st, anims[g], anims.speed || 1),
          pickable: interactive,
          onClick: onClick,
          parameters: { depthTest: true },
          updateTriggers: { getPosition: t, getOrientation: t, getColor: 'head' },
        }));
      });
      return out;
    }
    if (head.kind !== 'none' && ScatterCtor) {   // dot, or fallback while/if the model can't load
      const r0 = head.dot.getRadius;
      return [new ScatterCtor(Object.assign({}, head.dot, {
        id: base.id + '-head',
        data: headData(base, st, spec, t),
        getPosition: function (d) { return d.position; },
        getRadius: function (d) { return r0 * d.scale; },   // smaller at rest, a little bigger when fast
        getFillColor: function (d) { return d.color; },
        billboard: true,
        pickable: interactive,
        onClick: onClick,
        parameters: { depthTest: false },  // always visible over the terrain
        updateTriggers: { getPosition: t, getRadius: t, getFillColor: 'head' },
      }))];
    }
    headData(base, st, spec, t);   // no marker drawn, but labels, gap tags and follow still need positions
    return [];
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
        // Speeds while moving, for the speed response (typical) and the speed colours (95th percentile).
        const moving = [];
        tracks.forEach(function (tr) {
          if (!tr) return;
          for (let j = 0; j + 1 < tr.T.length; j++) {
            const v = segKmh(tr, j);
            if (!tr.gap[j] && v >= PACING.restKmh) moving.push(v);
          }
        });
        moving.sort(function (a, b) { return a - b; });
        const st = {
          cursors: new Array(n).fill(0), lastHeading: new Array(n).fill(0),
          tracks: tracks, colors: colors, labels: col(spec.labelCol), tips: col(spec.tipCol),
          trailData: trailRows(feats, tracks, spec), heads: [],
          typKmh: moving.length ? moving[moving.length >> 1] : 0,
          p95Kmh: moving.length ? moving[Math.floor(moving.length * 0.95)] : 0,
          anims: {},
        };
        st.vertexColors = vertexColors(st.trailData, spec, st);
        return st;
      },
      build: function (base, spec, st, t) {
        const layers = [];
        const data = st.trailData;   // split at gaps / curved; the same array every frame
        // Speed or day/night colours: one colour per vertex, for the comet and its glow.
        const colorProps = st.vertexColors
          ? { getColor: function (d, info) { return st.vertexColors[info.index]; },
              updateTriggers: { getColor: spec.cometColor } }
          : {};
        if (spec.showHistory) {
          // Inherit the comet's width from the TripsLayer (do NOT override getWidth). The history ends
          // historyLag of a comet behind the head, so the comet's bright tail fades into it.
          layers.push(base.clone({
            id: base.id + '-history',
            data: data,
            currentTime: t - (spec.historyLag || 0) * spec.cometTrail,
            trailLength: spec.historyTrail,
            fadeTrail: spec.fadeHistory,
            opacity: spec.historyOpacity,
            getColor: spec.historyColor,     // constant -> the whole track is this colour
            updateTriggers: { getColor: 'history' },
          }));
        }
        if (spec.glow) {   // the comet again, wider and faint, underneath it
          const p = base.props, k = spec.glow.width;
          layers.push(base.clone(Object.assign({
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
          }, colorProps)));
        }
        layers.push(base.clone(Object.assign({
          id: base.id + '-comet',
          data: data,
          currentTime: t,
          trailLength: spec.cometTrail,
          fadeTrail: true,
          opacity: 0.98,
        }, colorProps)));
        const heads = headLayers(base, st, spec, t);
        const decor = decorLayers(base, st, spec, t);
        // pulse under the marker; labels and gap tags over it
        const pulse = decor.filter(function (l) { return /-pulse$/.test(l.id); });
        const rest = decor.filter(function (l) { return !/-pulse$/.test(l.id); });
        return { layers: layers, overlay: pulse.concat(heads, rest) };
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
    const half = SUN.smoothS * dataRate(t);                    // data seconds either side
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
    const secondsPerDay = 86400 / dataRate(currentTime);
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
    shadowSun = { direction: sunLight.direction, strength: mix(s.strength, 1) };
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
    sunCenter = dataCenter() || [0, 0];
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
    const v = _deckViewState || currentView();
    followCenter = v ? [v.longitude, v.latitude] : null;   // glide from here to the marker
    followTs = performance.now();
    followView();
  }

  function stopFollow() { following = null; followCenter = null; }

  // Keep the followed marker centred. With FOLLOW_S the camera eases towards it (an exponential
  // approach that covers ~95% of the way in FOLLOW_S), so it trails the marker slightly and settles
  // softly instead of jumping with every fix.
  function followView() {
    if (!following || window.__camPreviewOn || !animatedById) return;
    const a = animatedById[following.layerId];
    const h = a && (a.state.heads || []).find(function (d) { return d.fi === following.fi; });
    if (!h) return;                                  // inside a data gap: hold the camera
    const v = _deckViewState || currentView();
    if (!v) return;
    const now = performance.now();
    let lon = h.position[0], lat = h.position[1];
    if (FOLLOW_S > 0 && followCenter) {
      const k = 1 - Math.exp(-Math.max(0, now - followTs) / (FOLLOW_S * 1000 / 3));
      lon = followCenter[0] + (lon - followCenter[0]) * k;
      lat = followCenter[1] + (lat - followCenter[1]) * k;
    }
    followTs = now;
    followCenter = [lon, lat];
    _deckViewState = Object.assign({}, v, { longitude: lon, latitude: lat });
    if (autoRotateSpeed === 0) deck.setProps({ viewState: _deckViewState });
    else if (!isPlaying) deck.setProps({ viewState: Object.assign({}, _deckViewState, { bearing: rotateBearing }) });
    // while playing with auto-rotation, frame() applies _deckViewState together with the bearing
    // Paused, nothing redraws, so keep gliding until the camera reaches the marker.
    const far = Math.abs(lon - h.position[0]) + Math.abs(lat - h.position[1]) > 1e-7;
    if (far && !isPlaying && !followRaf) {
      followRaf = requestAnimationFrame(function () { followRaf = 0; followView(); });
    }
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
  let playbackRate = 1;  // viewer's speed multiplier on top of durationSec (not used by the exporter); effRate eases to it

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

  // Play / pause. A pause eases the speed down to a stop over EASE_S (interactive); `hard` stops at
  // once (the end of the clip, the exporter).
  function setPlaying(on, hard) {
    if (loadingMap) autoplayOff = true;   // a choice made while loading replaces autoplay
    if (on) {
      if (progress >= 1) { progress = 0; currentTime = 0; effRate = 0; }   // play at the end -> start over
      pausing = false;
      if (!isPlaying) {
        isPlaying = true; lastTickTs = null;
        if (!(EASE_S > 0)) effRate = playbackRate;
        requestAnimationFrame(frame);
      }
    } else if (isPlaying && EASE_S > 0 && !hard) {
      pausing = true;
    } else {
      isPlaying = false; pausing = false; effRate = 0;
    }
    updateControls();
  }

  function seekTo(t) {
    currentTime = Math.max(0, Math.min(maxTime, t));
    progress = progressAt(currentTime);
  }

  function updateControls() {
    if (!controls) return;
    if (controls.play) {
      const playing = isPlaying && !pausing;
      controls.play.textContent = playing ? '❚❚' : '▶';
      controls.play.title = playing ? 'Pause' : 'Play';
    }
    if (controls.slider && document.activeElement !== controls.slider) controls.slider.value = currentTime;
    if (controls.label) {
      controls.label.textContent = loadingMap && !autoplayOff ? 'Loading map…' : formatTime(currentTime);
    }
    if (controls.clock) {   // playback position / total length, at the current speed
      const total = durationSec / playbackRate;
      controls.clock.textContent = formatClock(total * progress) + ' / ' + formatClock(total);
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
      button('↺', 'Restart', function () { seekTo(0); effRate = 0; lastTickTs = null; redraw(); setPlaying(true); });
    }
    if (CONTROLS.show_scrubber) {
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = 0; slider.max = maxTime; slider.step = maxTime / 1000;
      slider.style.cssText = 'flex:1;min-width:60px;accent-color:#fff;';
      slider.addEventListener('input', function () {
        seekTo(Number(slider.value)); lastTickTs = null; redraw();
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

    // Advance by elapsed wall time so playback lasts durationSec whatever the frame rate. The rate
    // eases towards its target (the chosen speed, or 0 while pausing) over EASE_S, and slows into
    // the end of the clip; playback progress then maps to data time (adaptive speed).
    const dt = lastTickTs === null ? 0 : timestamp - lastTickTs;
    lastTickTs = timestamp;
    const target = pausing ? 0 : playbackRate;
    effRate = EASE_S > 0 ? effRate + (target - effRate) * (1 - Math.exp(-dt / (EASE_S * 1000 / 3))) : target;
    if (pausing && effRate < 0.02 * playbackRate) {
      setPlaying(false, true);
      redraw();
      return;
    }
    if (progress < 1) {
      const leftS = (1 - progress) * durationSec / playbackRate;            // wall seconds to the end
      const endEase = EASE_S > 0 ? 0.12 + 0.88 * smoothstep(0, EASE_S, leftS) : 1;
      progress = Math.min(1, progress + dt / (durationSec * 1000) * effRate * endEase);
      currentTime = timeAt(progress);
    } else {
      setPlaying(false, true);  // Stop animation at the end
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

  // The view that fits [w, s, e, n] in a width x height frame with `padding` px to spare, seen at
  // `pitch` and `bearing`. A plain fitBounds frames the box as if looking straight down; on a
  // tilted map the near edge then spills off the bottom and the far side leaves the top empty.
  // So start there and correct by the box's projected outline: rescale the zoom to fill the frame
  // and move the centre to where the outline's middle lands, a few times until it settles.
  function fitBoundsView(box, o) {
    const width = o.width, height = o.height, pitch = o.pitch || 0, bearing = o.bearing || 0;
    const pad = Math.max(0, Math.min(o.padding || 0, Math.min(width, height) / 2 - 10));
    const MIN_DEG = o.minDeg != null ? o.minDeg : 0.01;   // a point or a short track: ~1 km, not street level
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hw = Math.max(box[2] - box[0], MIN_DEG) / 2, hh = Math.max(box[3] - box[1], MIN_DEG) / 2;
    const fit = new WebMercatorViewport({ width: width, height: height })
      .fitBounds([[cx - hw, cy - hh], [cx + hw, cy + hh]], { padding: pad });
    const view = { longitude: fit.longitude, latitude: fit.latitude, zoom: fit.zoom, pitch: pitch, bearing: bearing };
    if (pitch || bearing) {
      // The outline: corners and edge midpoints (the far edge bows on a tilted map).
      const pts = [];
      for (let i = 0; i <= 2; i++) {
        for (let j = 0; j <= 2; j++) {
          if (i === 1 && j === 1) continue;
          pts.push([cx - hw + i * hw, cy - hh + j * hh]);
        }
      }
      for (let k = 0; k < 6; k++) {
        const vp = new WebMercatorViewport(Object.assign({ width: width, height: height }, view));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) {
          const xy = vp.project(p);
          if (!isFinite(xy[0]) || !isFinite(xy[1])) return view;   // behind the camera: keep the last fit
          x0 = Math.min(x0, xy[0]); x1 = Math.max(x1, xy[0]); y0 = Math.min(y0, xy[1]); y1 = Math.max(y1, xy[1]);
        }
        const scale = Math.min((width - 2 * pad) / Math.max(x1 - x0, 1), (height - 2 * pad) / Math.max(y1 - y0, 1));
        const mid = vp.unproject([(x0 + x1) / 2, (y0 + y1) / 2]);
        const dz = Math.log2(scale);
        view.longitude = mid[0]; view.latitude = mid[1]; view.zoom += dz;
        if (Math.abs(dz) < 0.005 && Math.abs((x0 + x1) / 2 - width / 2) < 1 && Math.abs((y0 + y1) / 2 - height / 2) < 1) break;
      }
    }
    if (o.maxZoom != null) view.zoom = Math.min(view.zoom, o.maxZoom);
    return view;
  }

  // Frame the opening view on the animated tracks at the map's real size (as the video's Fit
  // camera does), keeping the given pitch and bearing. The view passed in assumes an 800x600
  // map, so on a larger window it opens further out than it needs to.
  function fitToTracks() {
    const fit = props.fitView;
    if (!fit) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    Object.keys(animatedById).forEach(function (id) {
      const st = animatedById[id].state;
      ((st && st.tracks) || []).forEach(function (tr) {
        (tr ? tr.C : []).forEach(function (p) {
          if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
          if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
        });
      });
    });
    const canvas = deck.getCanvas ? deck.getCanvas() : deck.canvas;
    const width = deck.width || (canvas && canvas.clientWidth), height = deck.height || (canvas && canvas.clientHeight);
    if (!(e >= w && n >= s) || !width || !height) return;
    const ivs = deck.props.initialViewState || {};
    let v;
    try {
      v = fitBoundsView([w, s, e, n], { width: width, height: height, padding: fit.padding, maxZoom: fit.maxZoom,
                                        pitch: ivs.pitch, bearing: ivs.bearing });
    } catch (err) { return; }
    deck.setProps({ initialViewState: Object.assign({}, ivs, v) });
  }

  // --- Waiting for the map before autoplay ------------------------------------------
  // The base map (Mapbox/Carto style under deck, if any), every deck layer (terrain and tile
  // layers report isLoaded once the tiles in view are in) and a quiet network for QUIET_MS.
  const QUIET_MS = 400, MAP_WAIT_MAX_MS = 20000;
  let lastResourceTs = (typeof performance !== 'undefined') ? performance.now() : 0;
  let resourceObserver = null;
  try {
    resourceObserver = new PerformanceObserver(function () { lastResourceTs = performance.now(); });
    resourceObserver.observe({ type: 'resource', buffered: false });
  } catch (e) { resourceObserver = null; }

  function layersLoaded() {
    try {
      const lm = deck.layerManager;
      const ls = (lm && lm.getLayers) ? lm.getLayers() : [];
      return ls.every(function (l) { return l.parent || l.isLoaded !== false; });
    } catch (e) { return true; }
  }
  function baseMapLoaded() {
    try {
      const host = window.deckInstance || deck;
      const map = host.getMapboxMap ? host.getMapboxMap() : null;
      if (!map) return true;
      return map.loaded() && (!map.areTilesLoaded || map.areTilesLoaded());
    } catch (e) { return true; }
  }
  function mapLoaded() {
    return layersLoaded() && baseMapLoaded() && (performance.now() - lastResourceTs >= QUIET_MS);
  }
  function waitForMap(done) {
    const t0 = performance.now();
    (function poll() {
      if (destroyed) return;
      if (mapLoaded() || performance.now() - t0 > MAP_WAIT_MAX_MS) { done(); return; }
      setTimeout(poll, 100);
    })();
  }

  function start() {
    baseLayers = deck.props.layers.slice();
    animatedById = {};
    LAYER_SPECS.forEach(function (spec) {
      const base = baseLayers.find(function (l) { return l && l.id === spec.id; });
      if (!base) { console.warn('[TimelineAnimationWidget] animated layer not found: ' + spec.id); return; }
      const animator = ANIMATORS[spec.kind];
      animatedById[spec.id] = { base: base, spec: spec, animator: animator, state: animator.init(base, spec) };
    });
    buildPacing();
    fitToTracks();
    // 3D-model animations read deck's own Timeline; the exporter sets it to the playback time.
    deckTimeline = (deck.animationLoop && deck.animationLoop.timeline) || null;

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
    redraw();
    // Autoplay once the map has loaded, so playback doesn't run over a half-drawn base map.
    waitForMap(function () {
      loadingMap = false;
      if (resourceObserver) { resourceObserver.disconnect(); resourceObserver = null; }
      if (!autoplayOff) setPlaying(true);
      else updateControls();
    });
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
    // Playback progress (0..1) <-> timeline time: the exporter spaces frames evenly in progress, so
    // adaptive speed shows in the video as it does on the map.
    timeAt(p)     { return timeAt(p); },
    progressAt(t) { return progressAt(t); },
    pause() { setPlaying(false, true); },
    setView(view) { releaseCamera(view); },
    play()  { setPlaying(true); },
    // The base map, every layer's tiles and the network are settled (see waitForMap).
    mapLoaded() { return layersLoaded() && baseMapLoaded(); },
    // The data time at t as the playback bar shows it (date-time at the UTC offset, or elapsed).
    formatTime(t) { return formatTime(t); },
    // Marker labels on or off (the exporter's video overlays).
    setLabels(on) { labelsOn = !!on; redraw(); },
    // The view fitting box [w, s, e, n] at a size, pitch and bearing (see fitBoundsView).
    fitBounds(box, opts) { return fitBoundsView(box, opts); },
    renderAt(t) {
      if (loadingMap) autoplayOff = true;
      isPlaying = false; pausing = false; effRate = 0;
      seekTo(t);
      // Headless: 3D-model animations at the playback time, so every exported frame is exact.
      if (headless && deckTimeline) { deckTimeline.pause(); deckTimeline.setTime(progress * durationSec * 1000); }
      redraw();
    }
  };
  window.__tripsAnim = bridge;

  return {
    destroy: function () {
      destroyed = true;
      isPlaying = false;
      clearInterval(startTimer);
      if (resourceObserver) resourceObserver.disconnect();
      document.removeEventListener('keydown', onEscape);
      if (controls) controls.root.remove();
      controls = null;
      if (window.__tripsAnim === bridge) delete window.__tripsAnim;
    }
  };
}
