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
  function travelHeading(a, b) {
    if (!a || !b) return null;
    return headingLL([a.longitude, a.latitude], [b.longitude, b.latitude]);
  }
  function clamp01(u) { return Math.max(0, Math.min(1, u)); }
  function ease(u) { u = clamp01(u); return u * u * (3 - 2 * u); }
  // A "share of the gap closed every 1/30 s" setting, rescaled to the frame rate.
  function rate(share, fallback, fps) {
    var s = clamp01(share == null ? fallback : share);
    return s > 0 ? 1 - Math.pow(1 - s, 30 / (fps || 30)) : 1;
  }
  // Google's `range` (camera-to-center metres) -> deck zoom. deck's MapView keeps the camera
  // `altitude` viewport-heights from the target (1.5 at its default ~37° field of view; a wider fov
  // brings it closer), and the world is 512 * 2^zoom px wide.
  function zoomForRange(rangeM, lat, height, fov) {
    var altitude = fov ? 0.5 / Math.tan(fov * Math.PI / 360) : 1.5;
    return Math.log2(altitude * height * EARTH_M * Math.cos(lat * Math.PI / 180) / (512 * rangeM));
  }
  function copies(v, n) { var out = []; for (var i = 0; i < n; i++) out.push(Object.assign({}, v)); return out; }

  function flyer() { var FTI = (window.deck || {}).FlyToInterpolator; return FTI ? new FTI({ curve: 1.414 }) : null; }

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
    var dt = Math.max((span() || 1) * 0.005, 1e-6);
    var dist = o.range_m || 800, tilt = o.tilt == null ? 60 : o.tilt;
    var kPos = rate(o.follow_smoothing, 0.3, o.fps), kTurn = rate(o.turn_smoothing, 0.15, o.fps);
    var cur = null, brg = null;
    return times.map(function (t) {
      var p = posAt(tr, t);
      if (o.heading != null) brg = o.heading;
      else {
        var h = headingLL(posAt(tr, t - dt), posAt(tr, t + dt));
        if (brg == null) brg = (h == null) ? base.bearing : h;
        else if (h != null) brg += shortestAngle(brg, h) * kTurn;
      }
      cur = cur ? [cur[0] + (p[0] - cur[0]) * kPos, cur[1] + (p[1] - cur[1]) * kPos,
                   cur[2] + ((p[2] || 0) - cur[2]) * kPos]
                : [p[0], p[1], p[2] || 0];
      return { longitude: cur[0], latitude: cur[1], zoom: zoomForRange(dist, cur[1], o.height, o.fov),
               pitch: tilt, bearing: brg, position: [0, 0, cur[2]] };
    });
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
    // follow_smoothing is per 1/30 s; rescale so the camera keeps up equally at any fps.
    var k = rate(o.follow_smoothing, 0.25, o.fps), keys = subjectKeys(o);
    var out = [], n = times.length;

    if (preset === 'chase') out = chasePath(times, o, base);
    else if (preset === 'keyframes') out = keyframesPath(times, o, base);
    else if (preset === 'follow') {
      var cur = null, prevTarget = null, cb = bearing;
      times.forEach(function (t) {
        var f = fitBox(recentBox(t, win, keys), o);     // smoothed framing of the recent action
        if (f) {
          cur = cur ? { longitude: cur.longitude + (f.longitude - cur.longitude) * k,
                        latitude:  cur.latitude  + (f.latitude  - cur.latitude ) * k,
                        zoom:      cur.zoom      + (f.zoom      - cur.zoom     ) * k } : f;
        }
        var v = cur || base;
        if (o.face_travel) {                             // smoothed heading of the camera's motion
          var h = travelHeading(prevTarget, v);
          prevTarget = v;
          if (h != null) cb += shortestAngle(cb, h) * Math.max(k, 0.12);
        }
        out.push({ longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: pitch, bearing: cb });
      });
    } else if (preset === 'fly_around' || preset === 'fixed') {
      var flyOpts = preset === 'fixed' ? Object.assign({}, o, { fly_frac: 0, rounds: 0 }) : o;
      var FA = flyAroundSetup(flyOpts, base);
      for (var i = 0; i < n; i++) out.push(flyAroundView(FA, n > 1 ? i / (n - 1) : 1));
    } else {
      out = copies(base, n);
    }
    return applyLens(out, o);
  }

  return { span: span, initialView: initialView, path: path };
}

if (typeof window !== 'undefined') window.__cam = createCameraPath();
