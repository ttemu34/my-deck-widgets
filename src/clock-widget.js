// The data's date and time as a clock in a corner of the animated map (PlaybackControls'
// show_time / time_position). TimelineAnimationWidget sets its text as playback moves, through
// window.__mapClock. A deck.gl widget, so deck puts it in its corner; it sits beside the corner's
// buttons rather than in their stack, so they keep their places. The video exporter hides it and draws
// its own clock, sized to the video.

import { Widget } from '@deck.gl/core';
import { THEME_SURFACE } from './widget-theme';

export class ClockWidget extends Widget {
  placement = 'top-right';
  className = 'map-clock-widget';

  constructor(props) {
    super(props, ClockWidget.defaultProps);
    // A class field would otherwise override the corner the page asked for.
    if (props && props.placement) this.placement = props.placement;
    this._el = null;
    this._text = '';
  }

  onAdd() {
    window.__mapClock = this;
  }

  onRemove() {
    if (window.__mapClock === this) delete window.__mapClock;
    this._el = null;
  }

  setText(text) {
    this._text = text || '';
    if (this._el && this._el.textContent !== this._text) this._el.textContent = this._text;
  }

  onRenderHTML(rootElement) {
    // Out of the corner's flow, beside its buttons (towards the middle of the map) and level with the
    // first of them: in the stack it pushed the map's buttons (save image, fullscreen, loading) down a row.
    // The same placement as the open Camera panel, which covers the clock while it is open.
    const [vert, horiz] = (this.placement || 'top-right').split('-');
    Object.assign(rootElement.style, {
      position: 'absolute', top: '', bottom: '', left: '', right: '', margin: '0',
    });
    // Level with the corner's first button, which deck spaces this far from the map's edge.
    rootElement.style[vert] = '0';
    rootElement.style['margin' + vert[0].toUpperCase() + vert.slice(1)] = 'var(--widget-margin, 12px)';
    if (horiz === 'right') { rootElement.style.right = '100%'; rootElement.style.marginRight = '4px'; }
    else { rootElement.style.left = '100%'; rootElement.style.marginLeft = '4px'; }
    if (!this._el || this._el.parentElement !== rootElement) {
      rootElement.textContent = '';
      this._el = document.createElement('div');
      this._el.title = 'Date and time in the data';
      this._el.style.cssText = 'padding:5px 12px;' + THEME_SURFACE +
        'font:600 15px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;font-variant-numeric:tabular-nums;' +
        'white-space:nowrap;pointer-events:auto;';
      rootElement.appendChild(this._el);
    }
    this._el.textContent = this._text;
  }
}

ClockWidget.defaultProps = {
  ...Widget.defaultProps,
  id: 'map-clock',
  placement: 'top-right'
};
