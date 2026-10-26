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
// - window.__cam: the camera helper (_CAM_HELPER), injected by the Python side.
// - window.__tripsAnim / window.deckInstance: from TimelineAnimationWidget.
// Page globals it publishes (TimelineAnimationWidget reads them):
// - window.__camPanel: { toggle(), settings } -- the playback bar's camera button.
// - window.__camPreview(t) / window.__camPreviewOn: the preview drives the view.
//
// The widget renders nothing in its placement corner; the panel is its own
// overlay (#camera-panel), opened from the playback bar.

import { Widget } from '@deck.gl/core';

export class CameraPanelWidget extends Widget {
  placement = 'top-right';
  className = 'camera-panel-widget';

  constructor(props) {
    super(props, CameraPanelWidget.defaultProps);
    this._panel = null;
  }

  onAdd() {
    this._panel = createCameraPanel(this.props.cameras);
  }

  onRemove() {
    if (this._panel) this._panel.destroy();
    this._panel = null;
  }

  onRenderHTML(rootElement) {
    rootElement.style.display = 'none';
  }
}

CameraPanelWidget.defaultProps = {
  ...Widget.defaultProps,
  id: 'camera-panel',
  cameras: []   // camera_panel_schema(): [{ type, title, description, fields: [...] }]
};

function createCameraPanel(CAMERAS) {
  const PREVIEW_FPS = 30;
  let views = null, lastView = null, panel = null, body = null, preview = false;

  // A camera being edited: its type and every type's field values (so switching type and back
  // keeps them).
  function newCamera(type) {
    const cs = { type: type, values: {} };
    CAMERAS.forEach(function (c) {
      cs.values[c.type] = {};
      c.fields.forEach(function (f) {
        cs.values[c.type][f.name] = Array.isArray(f.default) ? f.default.slice() : f.default;
      });
    });
    return cs;
  }
  const root = newCamera(CAMERAS[0].type);

  function camera(type) { return CAMERAS.find(function (c) { return c.type === type; }); }
  function camSpan() { return window.__cam.span() || window.__tripsAnim.span; }
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
    return out;
  }

  // Same shape as render_animation's _camera_opts.
  function pathOptions(cs, dims) {
    const s = settings(cs);
    const o = Object.assign({}, s, dims, { preset: s.type_ });
    delete o.type_;
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
    lastView = v;
    window.deckInstance.setProps({ viewState: Object.assign({}, v) });
  };
  function setPreview(on) {
    preview = on;
    window.__camPreviewOn = on;
    if (on) { invalidate(); return; }
    window.__tripsAnim.setView(lastView || currentView());
  }

  // --- Panel UI ----------------------------------------------------------------------------
  const CSS = 'position:absolute;top:56px;right:12px;z-index:11;width:300px;max-height:calc(100% - 170px);' +
    'overflow:auto;padding:10px 12px;border-radius:8px;box-sizing:border-box;' +
    'background:rgba(20,20,20,0.85);color:#fff;font:12px/1.35 system-ui,sans-serif;';
  const INPUT = 'width:100%;box-sizing:border-box;margin-top:2px;padding:3px 5px;border-radius:4px;' +
    'border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#fff;font:inherit;';
  const BUTTON = 'padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.35);' +
    'background:rgba(255,255,255,0.1);color:#fff;font:inherit;cursor:pointer;';
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
    options.forEach(function (o) { const opt = el('option', '', o[1]); opt.value = o[0]; s.appendChild(opt); });
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

  function cameraForm(parent, cs) {
    row(parent, 'Camera', '', select(CAMERAS.map(function (c) { return [c.type, c.title]; }), cs.type,
                                     function (v) { cs.type = v; invalidate(); render(); }));
    const cam = camera(cs.type);
    parent.appendChild(el('div', 'opacity:0.7;margin-top:4px;', cam.description));
    cam.fields.forEach(function (f) { row(parent, f.title, f.description, fieldInput(f, cs.values[cs.type])); });
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
    button(btns, 'Copy settings', "Copy, then paste into render_animation's Camera settings", function () {
      copyText(JSON.stringify(settings(root)), function () { note.textContent = 'Copied'; });
    });
    button(btns, 'Download', "Save as a file to upload as render_animation's Camera settings", function () {
      const a = el('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(settings(root), null, 2)], { type: 'application/json' }));
      a.download = 'camera-settings.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    btns.appendChild(note);
    actions.appendChild(btns);
    actions.appendChild(el('div', 'opacity:0.7;margin-top:6px;',
      "Use these settings in the workflow's render step (Camera settings). The video refits the framing " +
      'to its own size, so it can differ slightly from this window.'));
    body.appendChild(actions);
    panel.scrollTop = scroll;
  }

  function build() {
    panel = el('div', CSS);
    panel.id = 'camera-panel';
    panel.hidden = true;
    const head = el('div', 'display:flex;align-items:center;font-weight:600;font-size:13px;');
    head.appendChild(el('span', 'flex:1;', 'Video camera'));
    const close = button(head, '✕', 'Close', function () { panel.hidden = true; });
    close.style.cssText = 'background:none;border:0;color:#fff;cursor:pointer;font-size:14px;';
    panel.appendChild(head);
    body = el('div');
    panel.appendChild(body);
    document.body.appendChild(panel);
    render();
  }

  window.__camPanel = {
    toggle: function () { if (!panel) build(); panel.hidden = !panel.hidden; },
    get settings() { return settings(root); },
  };

  return {
    destroy: function () {
      if (preview) setPreview(false);
      if (panel) panel.remove();
      delete window.__camPanel;
      delete window.__camPreview;
      delete window.__camPreviewOn;
    }
  };
}
