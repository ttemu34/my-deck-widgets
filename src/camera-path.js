// The video camera for ecoscope-workflows-ext-mep's animated maps, installed as window.__cam.
//
// render_animation (the video exporter) and CameraPanelWidget (its preview) both build every
// frame's view with it, so the panel shows exactly what the video gets. `path(times, opts)`
// returns one deck viewState per time; `opts` is render_animation's _camera_opts (the camera's
// fields plus the video's width, height and fps).
//
// Reads on the page:
// - window.jsonInput: the pydeck spec (draw_animated_map makes it a real global).
// - window.__tripsAnim: TimelineAnimationWidget's bridge (layer specs, fitBounds).
// - window.deck: FlyToInterpolator and WebMercatorViewport, when available.
// The scene is read on first use, so install this before the data loads and call it after.

import { THEME_SURFACE } from './widget-theme';

export function createCameraPath() {
  // ---------------------------------------------------------------------------
  // Scene: every animated layer, whatever its type. Trips contribute per-vertex
  // times; time-window layers (points, paths, polygons, ...) one time per row.
  // Layer specs come from draw_animated_map via window.__tripsAnim.specs.
  // ---------------------------------------------------------------------------
  var SCENE = null;
  var MAX_ZOOM = 16;          // never frame tighter than this
  var MIN_BOX_DEG = 0.02;     // frame at least ~2 km, so a lone point is not a close-up
  var EARTH_M = 40075016.686; // equator length; deck's world is 512 * 2^zoom px wide
  var M_PER_DEG = 111320;

  function rowTime(d) {
    if (d.__t !== undefined) return d.__t;
    return (d.properties && d.properties.__t !== undefined) ? d.properties.__t : NaN;
  }
  function flatten(c, out) {   // any GeoJSON coordinates -> [[lon, lat, z?], ...]
    if (!c || !c.length) return;
    if (typeof c[0] === 'number') { out.push(c); return; }
    for (var i = 0; i < c.length; i++) flatten(c[i], out);
  }
  function values(d) {         // every scalar property of a row, for subject matching
    var v = [], src = [d, d.properties || {}];
    for (var s = 0; s < src.length; s++) for (var k in src[s]) {
      var x = src[s][k];
      if (typeof x === 'string' || typeof x === 'number') v.push(String(x));
    }
    return v;
  }
  function matches(d, keys) {  // keys: null (everything) or subject values
    if (!keys) return true;
    var v = values(d);
    for (var i = 0; i < keys.length; i++) if (v.indexOf(keys[i]) >= 0) return true;
    return false;
  }
  function subjectKeys(o) {
    var s = o.subjects;
    return (s && s.length) ? s.map(String) : null;
  }
  function scene() {
    if (SCENE) return SCENE;
    var layers = (window.jsonInput && window.jsonInput.layers) || [];
    var specs = (window.__tripsAnim && window.__tripsAnim.specs) || [];
    if (!specs.length) {       // older pages: animate the first TripsLayer only
      var tl = layers.find(function (L) { return L && (L['@@type'] === 'TripsLayer' || ('currentTime' in L)); });
      if (tl) specs = [{ id: tl.id, kind: 'trips' }];
    }
    var tracks = [], rows = [], all = [], end = 0;
    specs.forEach(function (s) {
      var L = layers.find(function (l) { return l.id === s.id; });
      var data = (L && Array.isArray(L.data)) ? L.data : [];
      data.forEach(function (d) {
        if (s.kind === 'trips') {
          var C = d.geometry && d.geometry.coordinates, T = d.timestamps;
          if (!C || !T || !C.length) return;
          tracks.push({ d: d, C: C, T: T, id: s.id });
          for (var k = 0; k < C.length; k++) all.push(C[k]);
          end = Math.max(end, T[T.length - 1]);
        } else {
          var t = rowTime(d), P = [];
          flatten(d.geometry && d.geometry.coordinates, P);
          if (!P.length || !isFinite(t)) return;
          rows.push({ d: d, t: t, P: P, w: s.window, id: s.id });
          for (var j = 0; j < P.length; j++) all.push(P[j]);
          end = Math.max(end, t);
        }
      });
    });
    var b = new Box(); all.forEach(function (p) { b.add(p); });
    var sz = 0, hasZ = false;
    all.forEach(function (p) { sz += p[2] || 0; if (p[2]) hasZ = true; });
    var withZ = all.filter(function (p) { return p.length > 2 && isFinite(p[2]); });
    var stride = Math.max(1, Math.ceil(withZ.length / 4000)), pts = [];   // sample for ground heights
    for (var q = 0; q < withZ.length; q += stride) pts.push(withZ[q]);
    SCENE = { tracks: tracks, rows: rows, box: b, meanZ: all.length ? sz / all.length : 0, end: end,
              hasZ: hasZ, pts: pts };
    return SCENE;
  }

  function Box() { this.w = 180; this.s = 90; this.e = -180; this.n = -90; this.empty = true; }
  Box.prototype.add = function (p) {
    this.w = Math.min(this.w, p[0]); this.e = Math.max(this.e, p[0]);
    this.s = Math.min(this.s, p[1]); this.n = Math.max(this.n, p[1]); this.empty = false;
  };
  Box.prototype.center = function () { return { lon: (this.w + this.e) / 2, lat: (this.s + this.n) / 2 }; };

  function lowerBound(T, t) {
    var lo = 0, hi = T.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; }
    return lo;
  }
  function posAt(tr, t) {      // interpolated [lon, lat, z] of a track at time t (clamped)
    var C = tr.C, T = tr.T, last = T.length - 1;
    if (t <= T[0]) return C[0];
    if (t >= T[last]) return C[last];
    var j = Math.max(0, lowerBound(T, t) - 1), f = (T[j + 1] > T[j]) ? (t - T[j]) / (T[j + 1] - T[j]) : 0;
    var a = C[j], b = C[j + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * f];
  }
  function groundDist(a, b) {  // metres between two [lon, lat] points (small-distance approximation)
    var lat = (a[1] + b[1]) * 0.5 * Math.PI / 180;
    return Math.hypot((b[0] - a[0]) * Math.cos(lat), b[1] - a[1]) * M_PER_DEG;
  }
  function headingLL(a, b) {   // compass heading from a to b, or null when they coincide
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return null;
    var lat = (a[1] + b[1]) * 0.5 * Math.PI / 180;
    return Math.atan2((b[0] - a[0]) * Math.cos(lat), b[1] - a[1]) * 180 / Math.PI;
  }

  // What's on screen around t: track vertices from [t - w, t] + current positions, and the
  // rows each time-window layer is showing (its own window, or w for cumulative layers).
  function recentBox(t, w, keys) {
    var S = scene(), b = new Box();
    S.tracks.forEach(function (tr) {
      if (!matches(tr.d, keys)) return;
      if (t < tr.T[0] || t - w > tr.T[tr.T.length - 1]) return;     // not started / long finished
      for (var k = lowerBound(tr.T, t - w); k < tr.T.length && tr.T[k] <= t; k++) b.add(tr.C[k]);
      b.add(posAt(tr, t));
    });
    S.rows.forEach(function (r) {
      if (!matches(r.d, keys)) return;
      var from = t - (r.w == null ? w : Math.max(r.w, w));
      if (r.t >= from && r.t <= t) r.P.forEach(function (p) { b.add(p); });
    });
    return b;
  }
  // Fit a box to the video frame; boxes under MIN_BOX_DEG are widened around their center.
  // With the widget's tilt-aware fit (my-deck-widgets >= 0.15) the box fills the frame as seen
  // at the camera's tilt, heading and lens (path() puts them in o); otherwise it is fitted as if
  // looking straight down.
  function fitBox(b, o) {
    if (!b || b.empty) return null;
    var A = window.__tripsAnim, init = initialView() || {};
    if (A && typeof A.fitBounds === 'function') {
      try {
        var v = A.fitBounds([b.w, b.s, b.e, b.n], {
          width: o.width, height: o.height, padding: o.fit_padding == null ? 80 : o.fit_padding,
          pitch: o._pitch != null ? o._pitch : (init.pitch || 0),
          bearing: o._bearing != null ? o._bearing : (init.bearing || 0),
          fovy: o.fov || undefined, minDeg: MIN_BOX_DEG, maxZoom: MAX_ZOOM,
        });
        return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom };
      } catch (e) {}
    }
    var c = b.center(), VP = (window.deck || {}).WebMercatorViewport, z = MAX_ZOOM;
    var hw = Math.max(b.e - b.w, MIN_BOX_DEG) / 2, hh = Math.max(b.n - b.s, MIN_BOX_DEG) / 2;
    if (VP) {
      try {
        var f = new VP({ width: o.width, height: o.height })
          .fitBounds([[c.lon - hw, c.lat - hh], [c.lon + hw, c.lat + hh]],
                     { padding: o.fit_padding == null ? 80 : o.fit_padding });
        c = { lon: f.longitude, lat: f.latitude }; z = Math.min(f.zoom, MAX_ZOOM);
      } catch (e) {}
    }
    return { longitude: c.lon, latitude: c.lat, zoom: z };
  }

  function span() { return scene().end; }
  function initialView() { return (window.jsonInput && window.jsonInput.initialViewState) || null; }

  function shortestAngle(a, b) { var d = ((b - a + 180) % 360) - 180; return d <= -180 ? d + 360 : d; }
  function clamp01(u) { return Math.max(0, Math.min(1, u)); }
  function ease(u) { u = clamp01(u); return u * u * (3 - 2 * u); }
  // Google's `range` (camera-to-center metres) -> deck zoom. deck's MapView keeps the camera
  // `altitude` viewport-heights from the target (1.5 at its default ~37° field of view; a wider fov
  // brings it closer), and the world is 512 * 2^zoom px wide.
  function zoomForRange(rangeM, lat, height, fov) {
    var altitude = fov ? 0.5 / Math.tan(fov * Math.PI / 360) : 1.5;
    return Math.log2(altitude * height * EARTH_M * Math.cos(lat * Math.PI / 180) / (512 * rangeM));
  }
  // The inverse: the range a deck zoom stands for (the Camera panel's "Use current view").
  function rangeForZoom(zoom, lat, height, fov) {
    var altitude = fov ? 0.5 / Math.tan(fov * Math.PI / 360) : 1.5;
    return altitude * height * EARTH_M * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, zoom));
  }
  function copies(v, n) { var out = []; for (var i = 0; i < n; i++) out.push(Object.assign({}, v)); return out; }

  function flyer() { var FTI = (window.deck || {}).FlyToInterpolator; return FTI ? new FTI({ curve: 1.414 }) : null; }

  // ---------------------------------------------------------------------------
  // Following cameras: spring smoothing, lead room, zoom with the action
  // ---------------------------------------------------------------------------
  var MAX_PAN_VIEWS = 0.75;    // the camera pans at most this many view widths a second
  var MAX_TURN_DEG = 45;       // ...turns at most this many degrees a second
  var MAX_ZOOM_RATE = 1.0;     // ...and zooms at most this many levels a second
  // A "share of the gap closed every 1/30 s" setting as a spring's natural frequency (rad/s),
  // so the old settings keep their feel; 1 (or more) snaps.
  function omegaFor(share, fallback) {
    var s = clamp01(share == null ? fallback : share);
    if (s >= 1) return Infinity;
    if (s <= 0) return 0;
    return -30 * Math.log(1 - s);
  }
  // One step of a critically damped spring towards `target` (implicit, so stable at any dt).
  function springStep(s, target, omega, dt) {
    if (omega === Infinity) { s.v = (target - s.x) / dt; s.x = target; return; }
    var f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, inv = 1 / (f + hhoo);
    var x = (f * s.x + dt * s.v + hhoo * target) * inv;
    s.v = (s.v + hoo * (target - s.x)) * inv;
    s.x = x;
  }
  function capRate(s, x0, vmax, dt) {
    if (Math.abs(s.v) > vmax) { s.v = Math.sign(s.v) * vmax; s.x = x0 + s.v * dt; }
  }
  // Glides a view after moving targets: position and zoom with one spring, bearing with another,
  // each with a top speed, so the camera eases into and out of moves instead of jerking.
  function Follower(o, posShare, turnShare, posFallback, turnFallback) {
    this.dt = 1 / (o.fps || 30);
    this.wPos = omegaFor(posShare, posFallback);
    this.wTurn = omegaFor(turnShare, turnFallback);
    this.width = o.width || 1280;
    this.s = null;
    this.prev = null;      // last target, and its smoothed speed (m/s), for the pan cap
    this.tSpeed = 0;
    this.recent = [];      // the target's speed over the last few frames
    this.tVel = [0, 0];    // the target's smoothed velocity (deg/s), to aim ahead of a moving one
  }
  Follower.prototype.step = function (t) {   // t: {longitude, latitude, zoom, bearing}
    var dt = this.dt;
    if (!this.s) {
      this.s = { lon: { x: t.longitude, v: 0 }, lat: { x: t.latitude, v: 0 },
                 zoom: { x: t.zoom, v: 0 }, brg: { x: t.bearing, v: 0 } };
    } else {
      var S = this.s, lon0 = S.lon.x, lat0 = S.lat.x, z0 = S.zoom.x, b0 = S.brg.x;
      // A critically damped spring trails a steadily moving target by 2/omega seconds; aiming that far
      // ahead along the target's smoothed velocity keeps a steady subject where it is framed.
      var a = Math.min(1, dt / 0.25);
      this.tVel[0] += ((t.longitude - this.prev.longitude) / dt - this.tVel[0]) * a;
      this.tVel[1] += ((t.latitude - this.prev.latitude) / dt - this.tVel[1]) * a;
      var lagS = (this.wPos > 0 && this.wPos < Infinity) ? 2 / this.wPos : 0;
      springStep(S.lon, t.longitude + this.tVel[0] * lagS, this.wPos, dt);
      springStep(S.lat, t.latitude + this.tVel[1] * lagS, this.wPos, dt);
      springStep(S.zoom, t.zoom, this.wPos, dt);
      springStep(S.brg, b0 + shortestAngle(b0, t.bearing), this.wTurn, dt);
      // Top pan speed, in metres: a share of the view's width at the current zoom, but never below how
      // fast the target itself has been moving, so the camera keeps up with a fast subject while a
      // sudden jump of the target is still glided over.
      var kx = M_PER_DEG * Math.cos(S.lat.x * Math.PI / 180), ky = M_PER_DEG;
      // Median of the last 5 frames: follows a subject that sets off within a few frames, but ignores
      // a one-frame jump (a track starting, a new framing), which the camera glides over instead.
      this.recent.push(Math.hypot((t.longitude - this.prev.longitude) * kx, (t.latitude - this.prev.latitude) * ky) / dt);
      if (this.recent.length > 5) this.recent.shift();
      var med = this.recent.slice().sort(function (x, y) { return x - y; })[this.recent.length >> 1];
      this.tSpeed = Math.max(med, this.tSpeed * Math.exp(-dt / 0.5));
      var mpp = EARTH_M * Math.cos(S.lat.x * Math.PI / 180) / (512 * Math.pow(2, S.zoom.x));
      var vmax = Math.max(MAX_PAN_VIEWS * this.width * mpp, 1.25 * this.tSpeed);
      var vx = S.lon.v * kx, vy = S.lat.v * ky, sp = Math.hypot(vx, vy);
      if (sp > vmax) {
        var k = vmax / sp;
        S.lon.v *= k; S.lat.v *= k;
        S.lon.x = lon0 + S.lon.v * dt; S.lat.x = lat0 + S.lat.v * dt;
      }
      capRate(S.zoom, z0, MAX_ZOOM_RATE, dt);
      capRate(S.brg, b0, MAX_TURN_DEG, dt);
    }
    this.prev = t;
    return { longitude: this.s.lon.x, latitude: this.s.lat.x, zoom: this.s.zoom.x, bearing: this.s.brg.x };
  };

  // Typical moving speed of the tracks (metres per timeline second), for "zoom with the action".
  var TYPICAL = null;
  function typicalSpeed() {
    if (TYPICAL != null) return TYPICAL;
    var v = [];
    scene().tracks.forEach(function (tr) {
      for (var j = 0; j + 1 < tr.T.length; j++) {
        var dt = tr.T[j + 1] - tr.T[j];
        if (dt > 0) { var s = groundDist(tr.C[j], tr.C[j + 1]) / dt; if (s > 0) v.push(s); }
      }
    });
    v.sort(function (a, b) { return a - b; });
    TYPICAL = v.length ? v[v.length >> 1] : 0;
    return TYPICAL;
  }
  // Speed (m per timeline second) and heading of a track around t, over a window w.
  function motionAt(tr, t, w) {
    var a = posAt(tr, t - w / 2), b = posAt(tr, t + w / 2);
    return { speed: groundDist(a, b) / Math.max(w, 1e-9), heading: headingLL(a, b) };
  }
  // Zoom change for a speed ratio r (1 = typical): in up to a level at rest, out when fast.
  function speedZoomDelta(r, strength) {
    if (!strength || !isFinite(r)) return 0;
    return strength * Math.max(-1, Math.min(1, -Math.log2((r + 0.1) / 1.1) / 2));
  }
  // Ground metres across the view's height at a zoom/tilt (tilt stretches it, capped).
  function viewGroundM(zoom, lat, o, pitch) {
    var mpp = EARTH_M * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, zoom));
    return (o.height || 720) * mpp / Math.cos(Math.min(pitch || 0, 60) * Math.PI / 180);
  }
  // A point `m` metres from [lon, lat] towards compass heading h.
  function offsetLL(lon, lat, h, m) {
    var r = h * Math.PI / 180;
    return [lon + m * Math.sin(r) / (M_PER_DEG * Math.cos(lat * Math.PI / 180)), lat + m * Math.cos(r) / M_PER_DEG];
  }
  function motionWindow() { return Math.max((span() || 1) * 0.01, 1e-6); }

  // ---------------------------------------------------------------------------
  // Line of sight over the terrain (draw_animated_map's window.__terrainGrid)
  // ---------------------------------------------------------------------------
  var LOS_MIN_PITCH = 15, LOS_CLEARANCE_M = 15, LOS_PITCH_RATE = 25;   // deg, m, deg per second
  function terrainAt(lon, lat) {
    var G = window.__terrainGrid;
    if (!G || !G.z || lon < G.w || lon > G.e || lat < G.s || lat > G.n) return null;
    var fx = (lon - G.w) / (G.e - G.w) * (G.nx - 1), fy = (lat - G.s) / (G.n - G.s) * (G.ny - 1);
    var x0 = Math.min(G.nx - 2, Math.floor(fx)), y0 = Math.min(G.ny - 2, Math.floor(fy));
    var u = fx - x0, v = fy - y0, z = G.z, nx = G.nx;
    var a = z[y0 * nx + x0], b = z[y0 * nx + x0 + 1], c = z[(y0 + 1) * nx + x0], d = z[(y0 + 1) * nx + x0 + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  // Is the view's target visible from its camera at tilt p (no ridge in between, camera above ground)?
  function clearAt(v, p, R, tz) {
    var horiz = R * Math.sin(p * Math.PI / 180), up = R * Math.cos(p * Math.PI / 180);
    var back = (v.bearing || 0) + 180;
    for (var k = 1; k <= 16; k++) {
      var u = 0.06 + 0.94 * k / 16;                   // from just off the target to the camera
      var q = offsetLL(v.longitude, v.latitude, back, horiz * u);
      var g = terrainAt(q[0], q[1]);
      if (g != null && g + LOS_CLEARANCE_M > tz + up * u) return false;
    }
    return true;
  }
  // Lowers each view's tilt (raising the camera) until a ridge no longer hides what it looks at;
  // eased in ahead of the ridge and back out after it, at most LOS_PITCH_RATE degrees a second.
  function keepInView(out, o) {
    if (!window.__terrainGrid || o.keep_in_view === false || !out.length) return out;
    var dt = 1 / (o.fps || 30), lim = out.map(function (v) {
      var R = rangeForZoom(v.zoom, v.latitude, o.height || 720, o.fov || v.fovy);
      var tz = v.position ? v.position[2] : 0;
      for (var p = v.pitch; p > LOS_MIN_PITCH; p -= 5) if (clearAt(v, p, R, tz)) return p;
      return Math.min(v.pitch, LOS_MIN_PITCH);
    });
    var step = LOS_PITCH_RATE * dt;
    for (var i = lim.length - 2; i >= 0; i--) lim[i] = Math.min(lim[i], lim[i + 1] + step);   // ease in early
    for (var j = 1; j < lim.length; j++) lim[j] = Math.min(lim[j], lim[j - 1] + step);         // ...and out
    return out.map(function (v, i) { return lim[i] < v.pitch ? Object.assign({}, v, { pitch: lim[i] }) : v; });
  }
  var FOLLOWING = ['chase', 'follow', 'cinematic', 'tour'];

  // ---------------------------------------------------------------------------
  // Subjects
  // ---------------------------------------------------------------------------
  // One subject as a track ({T, C, d}): a matching trips track, else the time-ordered
  // centres of matching rows of point/polygon layers. No subject -> the longest-running track.
  function subjectTrack(subject) {
    var S = scene(), key = (subject == null || subject === '') ? null : String(subject);
    var tr = null;
    if (key == null) {
      S.tracks.forEach(function (x) {
        if (!tr || x.T[x.T.length - 1] - x.T[0] > tr.T[tr.T.length - 1] - tr.T[0]) tr = x;
      });
    } else {
      tr = S.tracks.find(function (x) { return values(x.d).indexOf(key) >= 0; }) || null;
    }
    if (tr) return tr;
    var rows = key == null ? [] : S.rows.filter(function (r) { return values(r.d).indexOf(key) >= 0; });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return a.t - b.t; });
    return {
      d: rows[0].d,
      T: rows.map(function (r) { return r.t; }),
      C: rows.map(function (r) {
        var b = new Box(), z = 0; r.P.forEach(function (p) { b.add(p); z += p[2] || 0; });
        var c = b.center(); return [c.lon, c.lat, z / r.P.length];
      }),
    };
  }
  // Height of the data nearest a point (draped tracks carry the terrain height).
  function groundZ(lon, lat) {
    var S = scene(), best = Infinity, z = S.meanZ, k = Math.cos(lat * Math.PI / 180);
    S.pts.forEach(function (p) {
      var d = Math.pow((p[0] - lon) * k, 2) + Math.pow(p[1] - lat, 2);
      if (d < best) { best = d; z = p[2] || 0; }
    });
    return z;
  }

  // ---------------------------------------------------------------------------
  // Fly to & around (Google Maps 3D flyCameraTo + flyCameraAround); Fixed view is
  // its end point held for the whole clip.
  // ---------------------------------------------------------------------------
  function flyAroundSetup(o, base) {
    var lon = (o.lon != null) ? o.lon : base.longitude, lat = (o.lat != null) ? o.lat : base.latitude;
    var zoom = (o.range_m != null) ? zoomForRange(o.range_m, lat, o.height, o.fov) : base.zoom;
    var end = { longitude: lon, latitude: lat, zoom: zoom, pitch: base.pitch, bearing: base.bearing };
    return { start: base, end: end, fly: flyer(),
             frac: o.fly_frac == null ? 0.25 : o.fly_frac, rounds: o.rounds == null ? 1 : o.rounds,
             width: o.width, height: o.height };
  }
  function flyAroundView(A, prog) {
    if (A.frac > 0 && prog < A.frac) {                     // flyCameraTo
      var s = prog / A.frac, e = s * s * (3 - 2 * s), v = null;
      if (A.fly) {
        try {
          var dims = { width: A.width, height: A.height };
          v = A.fly.interpolateProps(Object.assign({}, dims, A.start), Object.assign({}, dims, A.end), e);
        } catch (err) { v = null; }
      }
      if (!v) v = { longitude: A.start.longitude + (A.end.longitude - A.start.longitude) * e,
                    latitude:  A.start.latitude  + (A.end.latitude  - A.start.latitude ) * e,
                    zoom:      A.start.zoom      + (A.end.zoom      - A.start.zoom     ) * e };
      return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom,
               pitch: A.start.pitch, bearing: A.start.bearing };
    }
    var u = (A.frac < 1) ? (prog - A.frac) / (1 - A.frac) : 1;   // flyCameraAround
    return { longitude: A.end.longitude, latitude: A.end.latitude, zoom: A.end.zoom, pitch: A.end.pitch,
             bearing: (A.end.bearing + 360 * A.rounds * u) % 360 };
  }

  // ---------------------------------------------------------------------------
  // Follow a subject: behind it, facing where it is heading (or a set heading)
  // ---------------------------------------------------------------------------
  function chasePath(times, o, base) {
    var tr = subjectTrack(o.subject);
    if (!tr) return copies(base, times.length);
    return chaseViews(tr, times, o, base, null);
  }
  // Behind one subject, facing where it heads, with lead room ahead and the zoom following its pace.
  // `fol` carries the smoothing state across calls (Subject tour), or null for a fresh one.
  function chaseViews(tr, times, o, base, fol) {
    var w = motionWindow(), typ = typicalSpeed();
    var dist = o.range_m || 800, tilt = o.tilt == null ? 60 : o.tilt;
    var lead = o.lead_room == null ? 0.15 : o.lead_room, sz = o.speed_zoom == null ? 0.5 : o.speed_zoom;
    fol = fol || new Follower(o, o.follow_smoothing, o.turn_smoothing, 0.3, 0.15);
    var brg = null;
    return times.map(function (t) {
      var p = posAt(tr, t), m = motionAt(tr, t, w), r = typ > 0 ? m.speed / typ : 1;
      if (o.heading != null) brg = o.heading;
      else if (m.heading != null) brg = m.heading;
      else if (brg == null) brg = base.bearing;
      var zoom = zoomForRange(dist, p[1], o.height, o.fov) + speedZoomDelta(r, sz);
      // Lead room: look a little ahead of a moving subject, so it sits behind the frame's centre.
      var ahead = (m.heading != null ? lead * Math.min(1, r) : 0) * viewGroundM(zoom, p[1], o, tilt) * 0.5;
      var q = ahead > 0 ? offsetLL(p[0], p[1], m.heading, ahead) : p;
      var v = fol.step({ longitude: q[0], latitude: q[1], zoom: zoom, bearing: brg });
      return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: tilt, bearing: v.bearing,
               position: [0, 0, p[2] || 0] };
    });
  }

  // ---------------------------------------------------------------------------
  // Subject tour: each subject followed in turn for an equal share of the clip, flying between
  // them, with a name card as each one comes in
  // ---------------------------------------------------------------------------
  function trackLabel(tr, i) {
    var specs = (window.__tripsAnim && window.__tripsAnim.specs) || [];
    var s = specs.find(function (x) { return x.id === tr.id; }) || {};
    var col = s.tipCol || s.labelCol, v = col ? tr.d[col] : null;
    return (v != null && v !== '') ? String(v) : 'Subject ' + (i + 1);
  }
  function tourTracks(o) {
    var S = scene(), keys = subjectKeys(o);
    if (keys) {
      return keys.map(function (k) { return subjectTrack(k); }).filter(function (x) { return x && x.C; });
    }
    var list = S.tracks.slice();
    list.sort(function (a, b) { return trackLabel(a, 0).localeCompare(trackLabel(b, 0)); });
    return list;
  }
  var CARD_S = 3, CARD_IN_S = 0.4, CARD_OUT_S = 0.6;   // name card: seconds shown, fade in, fade out
  function tourPath(times, o, base) {
    var list = tourTracks(o), n = times.length, N = list.length;
    if (!N) return copies(base, n);
    var fps = o.fps || 30, trans = o.transition_frac == null ? 0.2 : o.transition_frac;
    var out = new Array(n), fly = flyer(), prevEnd = null;
    for (var k = 0; k < N; k++) {
      var i0 = Math.round(k * n / N), i1 = Math.round((k + 1) * n / N);
      if (i1 <= i0) continue;
      var seg = chaseViews(list[k], times.slice(i0, i1), o, base, null);
      var nTrans = k > 0 && prevEnd ? Math.round((i1 - i0) * trans) : 0;
      var label = o.name_cards === false ? null : trackLabel(list[k], k);
      for (var i = i0; i < i1; i++) {
        var v = seg[i - i0];
        if (i - i0 < nTrans) {                            // fly from the last subject to this one
          var e = ease((i - i0 + 1) / (nTrans + 1)), f = null;
          if (fly) {
            try {
              var dims = { width: o.width || 1280, height: o.height || 720 };
              f = fly.interpolateProps(Object.assign({}, dims, prevEnd), Object.assign({}, dims, v), e);
            } catch (err) { f = null; }
          }
          var lerp = function (a, b) { return a + (b - a) * e; };
          v = Object.assign({}, v, {
            longitude: f ? f.longitude : lerp(prevEnd.longitude, v.longitude),
            latitude: f ? f.latitude : lerp(prevEnd.latitude, v.latitude),
            zoom: f ? f.zoom : lerp(prevEnd.zoom, v.zoom),
            bearing: prevEnd.bearing + shortestAngle(prevEnd.bearing, v.bearing) * e,
            pitch: lerp(prevEnd.pitch, v.pitch),
            position: [0, 0, lerp(prevEnd.position[2], v.position[2])],
          });
        }
        if (label) {                                      // name card, timed in video seconds
          var s = (i - i0) / fps, sIn = nTrans / fps;
          if (s >= sIn && s < sIn + CARD_S) {
            var a = Math.min(1, (s - sIn) / CARD_IN_S, (sIn + CARD_S - s) / CARD_OUT_S);
            v = Object.assign({}, v, { caption: label, captionOpacity: Math.max(0, a) });
          }
        }
        out[i] = v;
      }
      prevEnd = out[i1 - 1];
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Keyframes: fly through waypoints, given or derived from a subject's track
  // ---------------------------------------------------------------------------
  function catmullRom(p0, p1, p2, p3, u) {
    return 0.5 * ((2 * p1) + (-p0 + p2) * u
           + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
           + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  }
  // Keyframes arrive resolved (_resolve_keyframes): sorted, t in [0,1], bearings unwrapped;
  // a zoom/pitch/bearing no keyframe set is null and filled from `base` here.
  function keyframeView(K, prog, easing) {
    var hi = K.length - 1, s = 0;
    while (s + 1 < hi && K[s + 1].t <= prog) s++;
    var A = K[s], B = K[Math.min(s + 1, hi)];
    var u = clamp01((B.t > A.t) ? (prog - A.t) / (B.t - A.t) : 1);
    var e = (easing === 'linear' || easing === 'spline') ? u : ease(u);
    var lon, lat;
    if (easing === 'spline') {
      var P0 = K[Math.max(0, s - 1)], P3 = K[Math.min(hi, s + 2)];
      lon = catmullRom(P0.lon, A.lon, B.lon, P3.lon, u);
      lat = catmullRom(P0.lat, A.lat, B.lat, P3.lat, u);
    } else {
      lon = A.lon + (B.lon - A.lon) * e;
      lat = A.lat + (B.lat - A.lat) * e;
    }
    return { longitude: lon, latitude: lat,
             zoom:    A.zoom    + (B.zoom    - A.zoom   ) * e,
             pitch:   A.pitch   + (B.pitch   - A.pitch  ) * e,
             bearing: A.bearing + (B.bearing - A.bearing) * e };
  }
  // No waypoints: 12 along the subject's track, all framed to fit the whole track.
  function autoKeyframes(o, base) {
    var tr = subjectTrack(o.subject);
    if (!tr || tr.T.length < 2) return [];
    var n = 12, END = span() || 1, b = new Box();
    tr.C.forEach(function (p) { b.add(p); });
    var zoom = (fitBox(b, o) || base).zoom, out = [], T0 = tr.T[0], T1 = tr.T[tr.T.length - 1];
    for (var i = 0; i < n; i++) {
      var tt = T0 + (T1 - T0) * (i / (n - 1)), p = posAt(tr, tt);
      out.push({ t: Math.min(1, tt / END), lon: p[0], lat: p[1], zoom: zoom });
    }
    return out;
  }
  function keyframesPath(times, o, base) {
    var K = (o.keyframes && o.keyframes.length >= 2) ? o.keyframes : autoKeyframes(o, base);
    if (K.length < 2) return copies(base, times.length);
    K = K.map(function (q) {
      return Object.assign({}, q, { zoom: q.zoom == null ? base.zoom : q.zoom,
                                    pitch: q.pitch == null ? base.pitch : q.pitch,
                                    bearing: q.bearing == null ? base.bearing : q.bearing });
    });
    var n = times.length;
    return times.map(function (t, i) { return keyframeView(K, n > 1 ? i / (n - 1) : 1, o.keyframe_easing); });
  }

  // ---------------------------------------------------------------------------
  // Cinematic fly-through: opens on the whole scene, flies in to the action, then follows it
  // with a tilted camera that turns slowly (or faces the direction of travel)
  // ---------------------------------------------------------------------------
  // Mean motion of the subjects in play around t: their typical speed, and the heading the group
  // drifts (for lead room). Only tracks running at t, and matching `keys`, count.
  function groupMotion(t, w, keys) {
    var sx = 0, sy = 0, sp = 0, n = 0;
    scene().tracks.forEach(function (tr) {
      if (!matches(tr.d, keys) || t < tr.T[0] || t > tr.T[tr.T.length - 1]) return;
      var a = posAt(tr, t - w / 2), b = posAt(tr, t + w / 2), lat = (a[1] + b[1]) * 0.5 * Math.PI / 180;
      var dx = (b[0] - a[0]) * Math.cos(lat) * M_PER_DEG, dy = (b[1] - a[1]) * M_PER_DEG;
      sx += dx; sy += dy; sp += Math.hypot(dx, dy); n++;
    });
    if (!n) return { speed: 0, heading: null };
    var drift = Math.hypot(sx, sy) / n;
    return { speed: sp / n / Math.max(w, 1e-9), heading: drift > 0 ? Math.atan2(sx, sy) * 180 / Math.PI : null };
  }
  // Framing of the recent action, smoothed by a spring, with lead room in the direction the group
  // drifts and the zoom following its pace. bearingFor(motion, progress) gives the heading wanted
  // (null keeps the last one). Follow the action and Cinematic share it.
  function actionViews(times, o, base, c, bearingFor) {
    var w = motionWindow(), typ = typicalSpeed(), n = times.length;
    var lead = o.lead_room == null ? 0.1 : o.lead_room, sz = o.speed_zoom == null ? 0.3 : o.speed_zoom;
    var look = (o.lead_frac || 0) * c.END;
    var fol = new Follower(o, o.follow_smoothing, o.turn_smoothing, 0.25, 0.12);
    var last = base, brg = c.bearing;
    return times.map(function (t, i) {
      var prog = n > 1 ? i / (n - 1) : 1, tt = Math.min(c.END, t + look);
      var f = fitBox(recentBox(tt, c.win, c.keys), o) || last;
      last = f;
      var m = groupMotion(tt, w, c.keys), r = typ > 0 ? m.speed / typ : 1;
      var zoom = f.zoom + speedZoomDelta(r, sz);
      var ahead = m.heading != null ? lead * Math.min(1, r) * viewGroundM(zoom, f.latitude, o, c.pitch) * 0.5 : 0;
      var q = ahead > 0 ? offsetLL(f.longitude, f.latitude, m.heading, ahead) : [f.longitude, f.latitude];
      var b = bearingFor(m, prog);
      if (b != null) brg = b;
      var v = fol.step({ longitude: q[0], latitude: q[1], zoom: zoom, bearing: brg });
      return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: c.pitch, bearing: v.bearing };
    });
  }

  // ---------------------------------------------------------------------------
  // Cinematic fly-through: opens on the whole scene, flies in to the action, then follows it
  // with a tilted camera that turns slowly (or faces the direction of travel)
  // ---------------------------------------------------------------------------
  function cinematicPath(times, o, base, c) {
    var intro = o.intro_frac == null ? 0.12 : o.intro_frac, n = times.length;
    var mode = o.bearing_mode || 'rotate', turn = o.rotate_deg == null ? 45 : o.rotate_deg;
    var p0 = (initialView() || {}).pitch || 0;
    var views = actionViews(times, o, base, c, function (m, prog) {
      if (mode === 'heading') return m.heading;
      if (mode === 'fixed') return c.bearing;
      return c.bearing + turn * prog;
    });
    return views.map(function (vs, i) {
      var prog = n > 1 ? i / (n - 1) : 1;
      if (!(intro > 0 && prog < intro)) return vs;
      var e = ease(prog / intro);                          // fly in from the whole-scene view
      return { longitude: base.longitude + (vs.longitude - base.longitude) * e,
               latitude: base.latitude + (vs.latitude - base.latitude) * e,
               zoom: base.zoom + (vs.zoom - base.zoom) * e,
               pitch: p0 + (c.pitch - p0) * e,             // ...tilting from the map's angle
               bearing: vs.bearing };
    });
  }

  // ---------------------------------------------------------------------------
  // Lens and look-at height, applied to every camera's views
  // ---------------------------------------------------------------------------
  // fov -> the view's fovy. The point looked at sits on the draped tracks nearest it, or at a
  // followed subject's own height.
  function applyLens(out, o) {
    var S = scene();
    return out.map(function (v) {
      v = Object.assign({}, v);
      if (o.fov) v.fovy = o.fov;
      var z = v.position ? v.position[2] : (S.hasZ ? groundZ(v.longitude, v.latitude) : 0);
      v.position = [0, 0, z];
      return v;
    });
  }

  // ---------------------------------------------------------------------------
  // path(times, opts) -> one viewState per frame
  // ---------------------------------------------------------------------------
  function path(times, o) {
    o = o || {};
    var preset = o.preset, init = initialView() || {}, S = scene();
    // Tilt and heading: the camera's own, else the map's. Framing is fitted at these.
    var pitch = (o.tilt != null) ? o.tilt : (init.pitch || 0);
    var bearing = (o.heading != null) ? o.heading : (init.bearing || 0);
    o = Object.assign({}, o, { _pitch: pitch, _bearing: bearing });
    var whole = fitBox(S.box, o) || { longitude: init.longitude, latitude: init.latitude, zoom: init.zoom || 8 };
    var base = {
      longitude: whole.longitude, latitude: whole.latitude, zoom: whole.zoom, pitch: pitch, bearing: bearing
    };
    var END = span() || 1, win = (o.follow_window == null ? 0.1 : o.follow_window) * END;
    var keys = subjectKeys(o);
    var out = [], n = times.length;

    if (preset === 'chase') out = chasePath(times, o, base);
    else if (preset === 'keyframes') out = keyframesPath(times, o, base);
    else if (preset === 'tour') out = tourPath(times, o, base);
    else if (preset === 'follow') {
      out = actionViews(times, o, base, { END: END, win: win, keys: keys, pitch: pitch, bearing: bearing },
        function (m) { return o.face_travel && m.heading != null ? m.heading : null; });
    } else if (preset === 'cinematic') {
      out = cinematicPath(times, o, base, { END: END, win: win, keys: keys, pitch: pitch, bearing: bearing });
    } else if (preset === 'fly_around' || preset === 'fixed') {
      var flyOpts = preset === 'fixed' ? Object.assign({}, o, { fly_frac: 0, rounds: 0 }) : o;
      var FA = flyAroundSetup(flyOpts, base);
      for (var i = 0; i < n; i++) out.push(flyAroundView(FA, n > 1 ? i / (n - 1) : 1));
    } else {
      out = copies(base, n);
    }
    out = applyLens(out, o);
    return FOLLOWING.indexOf(preset) >= 0 ? keepInView(out, o) : out;
  }

  // ---------------------------------------------------------------------------
  // Name card (Subject tour): a view's `caption` at `captionOpacity`, shown over the map. The
  // Camera panel's preview and the video exporter call this for every frame they apply.
  // ---------------------------------------------------------------------------
  var captionEl = null;
  function caption(text, opacity) {
    if (typeof document === 'undefined') return;
    if (!text) { if (captionEl) captionEl.style.display = 'none'; return; }
    if (!captionEl) {
      captionEl = document.createElement('div');
      captionEl.id = 'camera-caption';
      captionEl.style.cssText = 'position:absolute;left:50%;top:28px;transform:translateX(-50%);z-index:11;' +
        'pointer-events:none;padding:8px 18px;white-space:nowrap;' + THEME_SURFACE +
        'font:600 clamp(16px, 3.4vh, 44px)/1.2 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:0.01em;';
      (document.getElementById('deck-container') || document.body).parentNode.appendChild(captionEl);
    }
    captionEl.textContent = text;
    captionEl.style.opacity = String(opacity == null ? 1 : opacity);
    captionEl.style.display = '';
  }
  // A view without this camera's own fields, for deck's viewState.
  function deckView(v) {
    if (!v) return v;
    var out = Object.assign({}, v);
    delete out.caption; delete out.captionOpacity;
    return out;
  }

  return { span: span, initialView: initialView, path: path, rangeForZoom: rangeForZoom,
           caption: caption, deckView: deckView };
}

if (typeof window !== 'undefined') window.__cam = createCameraPath();
