// A deck.gl Widget that adds the Camera panel to ecoscope-workflows-ext-mep's
// draw_animated_map: design the video camera on the map, preview it while playing,
// then copy or download its settings for render_animation.
//
// The form is built from render_animation's camera models (`cameras`, from the
// Python side's camera_panel_schema()), and the preview runs the exporter's own
// camera code (window.__cam), so what you see is what the video gets -- except
// that the video refits the framing to its own size.
//
// Needs on the page:
// - window.__cam: the video camera (camera-path.js, installed with this bundle).
// - window.__tripsAnim / window.deckInstance: from TimelineAnimationWidget.
// Page globals it publishes (TimelineAnimationWidget reads them):
// - window.__camPanel: { toggle(), settings } -- the playback bar's camera button.
// - window.__camPreview(t) / window.__camPreviewOn: the preview drives the view.
//
// The widget renders nothing in its placement corner; the panel is its own
// overlay (#camera-panel), opened from the playback bar.

import { Widget } from '@deck.gl/core';
import { THEME_SURFACE, MENU_SURFACE } from './widget-theme';

export class CameraPanelWidget extends Widget {
  placement = 'top-right';
  className = 'camera-panel-widget';

  constructor(props) {
    super(props, CameraPanelWidget.defaultProps);
    this._panel = null;
  }

  onAdd() {
    // The panel opens inside this widget's own root (a deck.gl widget container, top-right),
    // created by deck after onAdd, so it is looked up when the panel first opens.
    const self = this;
    this._panel = createCameraPanel(this.props.cameras, this.props, function () { return self.rootElement; });
  }

  onRemove() {
    if (this._panel) this._panel.destroy();
    this._panel = null;
  }

  onRenderHTML(rootElement) {
    // Shown only while the panel is open, so the closed panel takes no room in the corner.
    rootElement.style.display = this._panel && this._panel.isOpen() ? '' : 'none';
    // Out of the corner's flow: deck stacks a corner's widgets in one container, so the open
    // 300px panel would widen it and drag the fullscreen/loading buttons towards the middle of
    // the map. Overlaid just left of those buttons instead, the corner keeps its size.
    Object.assign(rootElement.style, {
      position: 'absolute', top: '0', right: '100%', marginRight: '4px', zIndex: '2',
    });
  }
}

CameraPanelWidget.defaultProps = {
  ...Widget.defaultProps,
  id: 'camera-panel',
  cameras: [],    // camera_panel_schema(): [{ type, title, description, fields: [...] }]
  initial: null,  // the workflow's camera, as render_animation takes it (camera_panel_initial()); null -> first camera
  preview: false  // start with the preview on, so playing shows the video's camera
};

function createCameraPanel(CAMERAS, opts, getRoot) {
  const PREVIEW_FPS = 30;
  // The video exporter drives the view itself, so the preview never runs headless.
  const headless = typeof navigator !== 'undefined' && !!navigator.webdriver;
  let views = null, lastView = null, panel = null, body = null;
  let preview = !!(opts && opts.preview) && !headless;
  window.__camPreviewOn = preview;

  // A camera being edited: its type, every type's field values (so switching type and back keeps
  // them), and the keyframes camera's waypoints and the subject it follows without them.
  function newCamera(type) {
    const cs = { type: type, values: {}, keyframes: [], subject: '' };
    CAMERAS.forEach(function (c) {
      cs.values[c.type] = {};
      c.fields.forEach(function (f) {
        cs.values[c.type][f.name] = Array.isArray(f.default) ? f.default.slice() : f.default;
      });
    });
    return cs;
  }
  function camera(type) { return CAMERAS.find(function (c) { return c.type === type; }); }

  // Open on the workflow's camera (the same settings object the panel copies), so the preview
  // matches the video. Keyframe channels the workflow left blank take the map's opening view.
  function applyInitial(cs, s) {
    if (!s || !camera(s.type_)) return;
    cs.type = s.type_;
    const values = cs.values[cs.type];
    Object.keys(values).forEach(function (k) { if (k in s) values[k] = s[k]; });
    if (cs.type !== 'keyframes') return;
    const ivs = (window.jsonInput && window.jsonInput.initialViewState) || {};
    cs.keyframes = (s.keyframes || []).map(function (k) {
      return { t: k.t, lon: k.lon, lat: k.lat,
               zoom: k.zoom != null ? k.zoom : (ivs.zoom || 0),
               pitch: k.pitch != null ? k.pitch : (ivs.pitch || 0),
               bearing: k.bearing != null ? k.bearing : (ivs.bearing || 0) };
    });
    cs.subject = (s.source && s.source.subject) || '';
  }
  const root = newCamera(CAMERAS[0].type);
  applyInitial(root, opts && opts.initial);
  function camSpan() { return window.__cam.span() || window.__tripsAnim.span; }
  function progress() { return Math.max(0, Math.min(1, window.__tripsAnim.time / camSpan())); }
  function round(x, n) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
  function currentView() {
    try {
      const v = window.deckInstance.getViewports()[0];
      return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing };
    } catch (e) { return lastView; }
  }
  // --- Settings: exactly the camera object render_animation takes -------------------------
  function settings(cs) {
    const out = { type_: cs.type }, values = cs.values[cs.type];
    // Unset values are the defaults; leaving them out keeps optional limits from rejecting null.
    Object.keys(values).forEach(function (k) { if (values[k] != null) out[k] = values[k]; });
    if (cs.type === 'keyframes') {
      if (cs.keyframes.length) {
        out.keyframes = cs.keyframes.map(function (k) {
          return { t: round(k.t, 4), lon: round(k.lon, 6), lat: round(k.lat, 6),
                   zoom: round(k.zoom, 2), pitch: round(k.pitch, 1), bearing: round(k.bearing, 1) };
        });
      } else {
        out.source = { type_: 'subject', subject: cs.subject || null };
      }
    }
    return out;
  }

  // Same shape as render_animation's _camera_opts; keyframes resolved as _resolve_keyframes does
  // for complete ones (sorted, bearings unwrapped for shortest turns).
  function pathOptions(cs, dims) {
    const s = settings(cs);
    const o = Object.assign({}, s, dims, { preset: s.type_ });
    delete o.type_; delete o.source;
    if (cs.type === 'keyframes') {
      o.subject = cs.subject || null;
      o.keyframes = null;
      if (cs.keyframes.length >= 2) {
        const K = cs.keyframes.slice().sort(function (a, b) { return a.t - b.t; }).map(function (k) {
          return Object.assign({}, k);
        });
        for (let i = 1; i < K.length; i++) {
          const d = ((K[i].bearing - K[i - 1].bearing + 180) % 360 + 360) % 360 - 180;
          K[i].bearing = K[i - 1].bearing + d;
        }
        o.keyframes = K;
      }
    }
    return o;
  }

  // --- Preview: one view per frame over the whole timeline, looked up by the current time -----
  function invalidate() { views = null; if (preview) window.__camPreview(window.__tripsAnim.time); }
  window.__camPreview = function (t) {
    if (!preview) return;
    if (!views) {
      const span = camSpan(), n = Math.max(2, Math.round(window.__tripsAnim.durationSec * PREVIEW_FPS));
      const canvas = document.querySelector('#deck-container canvas');
      const dims = { fps: PREVIEW_FPS, width: canvas ? canvas.clientWidth : 1280,
                     height: canvas ? canvas.clientHeight : 720 };
      const times = [];
      for (let i = 0; i < n; i++) times.push(span * i / (n - 1));
      views = window.__cam.path(times, pathOptions(root, dims));
    }
    const v = views[Math.round(Math.max(0, Math.min(1, t / camSpan())) * (views.length - 1))];
    if (!v) return;
    lastView = window.__cam.deckView(v);
    window.__cam.caption(v.caption, v.captionOpacity);
    window.deckInstance.setProps({ viewState: Object.assign({}, lastView) });
  };
  function setPreview(on) {
    preview = on;
    window.__camPreviewOn = on;
    if (on) { invalidate(); return; }
    window.__cam.caption(null);
    window.__tripsAnim.setView(lastView || currentView());
  }

  // Grabbing the map while the preview runs hands the view back to the viewer (the preview would
  // otherwise snap it back every frame), with a note on how to turn the preview on again.
  let toastEl = null, toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = el('div', 'position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:12;' +
        'padding:6px 10px;' + THEME_SURFACE + 'font:12px/1.35 system-ui,sans-serif;pointer-events:none;' +
        'transition:opacity .4s;max-width:calc(100% - 32px);');
      toastEl.id = 'camera-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 4000);
  }
  // The map itself, or deck.gl's own map buttons (zoom, compass, reset view).
  const STEER_BUTTONS = '.deck-widget-zoom, .deck-widget-compass, .deck-widget-reset-view, .deck-widget-gimbal';
  function onUserSteer(e) {
    const t = e.target;
    if (!preview || !t) return;
    if (t.tagName !== 'CANVAS' && !(e.type === 'pointerdown' && t.closest && t.closest(STEER_BUTTONS))) return;
    setPreview(false);
    if (panel) render();
    toast('Camera preview off while you move the map. Turn it back on in the Video camera panel.');
  }
  document.addEventListener('pointerdown', onUserSteer, true);
  document.addEventListener('wheel', onUserSteer, { capture: true, passive: true });

  // --- Panel UI ----------------------------------------------------------------------------
  // Inside the widget's deck.gl container (top-right corner, stacked with deck's own buttons), in
  // deck.gl's widget theme. color-scheme: dark makes the browser draw native parts (a select's
  // option list) dark too, instead of white text on a white list.
  const CSS = 'width:300px;max-width:calc(100vw - 80px);max-height:calc(100vh - 220px);overflow:auto;padding:10px 12px;' +
    'box-sizing:border-box;color-scheme:dark;pointer-events:auto;' + MENU_SURFACE +
    'font:12px/1.35 system-ui,sans-serif;';
  const INPUT = 'width:100%;box-sizing:border-box;margin-top:2px;padding:3px 5px;border-radius:4px;' +
    'border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:inherit;font:inherit;';
  const BUTTON = 'padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.35);' +
    'background:rgba(255,255,255,0.1);color:inherit;font:inherit;cursor:pointer;';
  const SECTION = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.2);';

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function row(parent, label, help, input) {
    const r = el('label', 'display:block;margin-top:8px;');
    r.appendChild(el('span', 'opacity:0.8;', label));
    if (help) r.title = help;
    r.appendChild(input);
    parent.appendChild(r);
    return r;
  }
  function button(parent, text, title, onClick) {
    const b = el('button', BUTTON, text);
    b.type = 'button'; b.title = title || '';
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }
  function select(options, value, onChange) {   // options: [[value, label], ...]
    const s = el('select', INPUT);
    options.forEach(function (o) {
      const opt = el('option', 'background:#202020;color:#fff;', o[1]);
      opt.value = o[0]; s.appendChild(opt);
    });
    s.value = value == null ? '' : value;
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function fieldInput(f, values) {
    let input;
    if (f.type === 'boolean') {
      input = el('input', 'margin-left:6px;vertical-align:middle;');
      input.type = 'checkbox'; input.checked = !!values[f.name];
      input.addEventListener('change', function () { values[f.name] = input.checked; invalidate(); });
      return input;
    }
    if (f.type === 'enum') {
      return select(f.options.map(function (o) { return [o, o]; }), values[f.name],
                    function (v) { values[f.name] = v; invalidate(); });
    }
    input = el('input', INPUT);
    if (f.type === 'array') {   // list of names, typed comma-separated
      input.type = 'text'; input.placeholder = 'all, or names separated by commas';
      input.value = (values[f.name] || []).join(', ');
      input.addEventListener('change', function () {
        const list = input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        values[f.name] = list.length ? list : null;
        invalidate();
      });
      return input;
    }
    const numeric = f.type === 'number' || f.type === 'integer';
    input.type = numeric ? 'number' : 'text';
    if (numeric) {
      input.step = f.type === 'integer' ? '1' : 'any';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
    }
    if (f.default == null) input.placeholder = 'auto';
    input.value = values[f.name] == null ? '' : values[f.name];
    input.addEventListener('change', function () {
      let v = input.value.trim();
      if (v === '') v = f.default;                     // blank -> the field's default (auto when None)
      else if (numeric) {
        v = Number(v);
        if (!isFinite(v)) v = f.default;
        else {
          if (f.min != null) v = Math.max(f.min, v);
          if (f.max != null) v = Math.min(f.max, v);
          if (f.type === 'integer') v = Math.round(v);
        }
      }
      values[f.name] = v;
      input.value = v == null ? '' : v;
      invalidate();
    });
    return input;
  }

  // The keyframes camera's waypoints: each is the map view at a moment of the clip.
  function keyframeSection(parent, cs) {
    const box = el('div', SECTION);
    box.appendChild(el('div', 'font-weight:600;', 'Keyframes'));
    box.appendChild(el('div', 'opacity:0.7;margin-top:2px;',
      'Scrub to a moment, frame the map, then add it. With fewer than 2 keyframes the camera follows a subject.'));
    const subject = el('input', INPUT);
    subject.type = 'text'; subject.placeholder = 'longest-running track'; subject.value = cs.subject;
    subject.addEventListener('change', function () { cs.subject = subject.value.trim(); invalidate(); });
    row(box, 'Subject to follow', 'Value identifying the subject in any column (e.g. its name).', subject);
    const add = el('div', 'margin-top:8px;');
    button(add, '+ Add current view', 'Add a keyframe at the current time with the current view', function () {
      const v = currentView();
      if (!v) return;
      cs.keyframes.push({ t: progress(), lon: v.longitude, lat: v.latitude, zoom: v.zoom, pitch: v.pitch || 0,
                          bearing: v.bearing || 0 });
      cs.keyframes.sort(function (a, b) { return a.t - b.t; });
      invalidate(); render();
    });
    box.appendChild(add);
    cs.keyframes.forEach(function (k, i) {
      const r = el('div', 'display:flex;align-items:center;gap:6px;margin-top:6px;font-variant-numeric:tabular-nums;');
      r.appendChild(el('span', 'flex:1;', (k.t * 100).toFixed(0) + '%  z' + k.zoom.toFixed(1) +
        '  tilt ' + k.pitch.toFixed(0) + '°  hdg ' + k.bearing.toFixed(0) + '°'));
      button(r, 'Go', 'Jump to this keyframe', function () {
        window.__tripsAnim.renderAt(k.t * camSpan());
        if (!preview) window.__tripsAnim.setView({ longitude: k.lon, latitude: k.lat, zoom: k.zoom,
                                                  pitch: k.pitch, bearing: k.bearing });
      });
      button(r, 'Set', 'Replace with the current view (keeps its time)', function () {
        const v = currentView();
        if (!v) return;
        Object.assign(k, { lon: v.longitude, lat: v.latitude, zoom: v.zoom, pitch: v.pitch || 0,
                           bearing: v.bearing || 0 });
        invalidate(); render();
      });
      button(r, '✕', 'Remove', function () { cs.keyframes.splice(i, 1); invalidate(); render(); });
      box.appendChild(r);
    });
    parent.appendChild(box);
  }

  function cameraForm(parent, cs) {
    row(parent, 'Camera', '', select(CAMERAS.map(function (c) { return [c.type, c.title]; }), cs.type,
                                     function (v) { cs.type = v; invalidate(); render(); }));
    const cam = camera(cs.type);
    parent.appendChild(el('div', 'opacity:0.7;margin-top:4px;', cam.description));
    if (cam.fields.some(function (f) { return f.name in VIEW_FIELDS; })) {
      const b = el('div', 'margin-top:8px;');
      button(b, 'Use current view', "Fill the camera's center, range, tilt and heading from the map as it is now",
             function () { useCurrentView(cs); });
      parent.appendChild(b);
    }
    cam.fields.forEach(function (f) { row(parent, f.title, f.description, fieldInput(f, cs.values[cs.type])); });
    if (cs.type === 'keyframes') keyframeSection(parent, cs);
  }

  // The map's view as the camera fields this camera has (Google Maps 3D terms: center, range in
  // metres, tilt, heading), so Copy settings captures what is on screen.
  const VIEW_FIELDS = { lon: 1, lat: 1, range_m: 1, tilt: 1, heading: 1 };
  function useCurrentView(cs) {
    const v = currentView();
    if (!v) return;
    const values = cs.values[cs.type];
    const canvas = document.querySelector('#deck-container canvas');
    const height = canvas ? canvas.clientHeight : 720;
    const heading = (((v.bearing || 0) + 180) % 360 + 360) % 360 - 180;
    const from = {
      lon: round(v.longitude, 6), lat: round(v.latitude, 6),
      range_m: Math.round(window.__cam.rangeForZoom(v.zoom, v.latitude, height, values.fov)),
      tilt: round(v.pitch || 0, 1), heading: round(heading, 1)
    };
    camera(cs.type).fields.forEach(function (f) {
      if (!(f.name in from)) return;
      let x = from[f.name];
      if (f.min != null) x = Math.max(f.min, x);
      if (f.max != null) x = Math.min(f.max, x);
      values[f.name] = x;
    });
    invalidate(); render();
  }

  function copyText(text, done) {
    function fallback() {   // sandboxed frames can block the Clipboard API
      const ta = el('textarea', 'position:fixed;left:-9999px;');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); } finally { ta.remove(); }
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function render() {
    const scroll = panel.scrollTop;
    body.innerHTML = '';
    cameraForm(body, root);

    const actions = el('div', SECTION);
    const prev = el('input', 'margin-right:6px;vertical-align:middle;');
    prev.type = 'checkbox'; prev.checked = preview;
    prev.addEventListener('change', function () { setPreview(prev.checked); });
    const pl = el('label', 'display:block;cursor:pointer;');
    pl.appendChild(prev); pl.appendChild(document.createTextNode('Preview camera while playing'));
    actions.appendChild(pl);
    const btns = el('div', 'display:flex;gap:6px;align-items:center;margin-top:8px;');
    const note = el('span', 'opacity:0.75;');
    button(btns, 'Copy settings', "Copy, then paste into the workflow's Camera settings", function () {
      copyText(JSON.stringify(settings(root)), function () { note.textContent = 'Copied'; });
    });
    button(btns, 'Download', "Save as a file to upload as the workflow's Camera settings", function () {
      const a = el('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(settings(root), null, 2)], { type: 'application/json' }));
      a.download = 'camera-settings.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    btns.appendChild(note);
    actions.appendChild(btns);
    actions.appendChild(el('div', 'opacity:0.7;margin-top:6px;',
      "Paste these into the workflow's Camera settings and re-run: the map's preview and the video " +
      'both use them. The video refits the framing to its own size, so it can differ slightly from this window.'));
    body.appendChild(actions);
    panel.scrollTop = scroll;
  }

  function build() {
    panel = el('div', CSS);
    panel.id = 'camera-panel';
    panel.hidden = true;
    const head = el('div', 'display:flex;align-items:center;font-weight:600;font-size:13px;');
    head.appendChild(el('span', 'flex:1;', 'Video camera'));
    const close = button(head, '✕', 'Close', function () { setOpen(false); });
    close.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font-size:14px;';
    panel.appendChild(head);
    body = el('div');
    panel.appendChild(body);
    (getRoot && getRoot() || document.body).appendChild(panel);
    render();
  }

  function setOpen(open) {
    if (!panel) build();
    panel.hidden = !open;
    const host = getRoot && getRoot();
    if (host) host.style.display = open ? '' : 'none';
  }

  window.__camPanel = {
    toggle: function () { setOpen(!panel || panel.hidden); },
    get settings() { return settings(root); },
  };

  return {
    isOpen: function () { return !!panel && !panel.hidden; },
    destroy: function () {
      if (preview) setPreview(false);
      document.removeEventListener('pointerdown', onUserSteer, true);
      document.removeEventListener('wheel', onUserSteer, { capture: true });
      clearTimeout(toastTimer);
      if (toastEl) toastEl.remove();
      if (panel) panel.remove();
      delete window.__camPanel;
      delete window.__camPreview;
      delete window.__camPreviewOn;
    }
  };
}
