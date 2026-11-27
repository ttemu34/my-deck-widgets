// The data's date and time as a clock in a corner of the animated map (PlaybackControls'
// show_time / time_position). TimelineAnimationWidget sets its text as playback moves, through
// window.__mapClock. A deck.gl widget, so deck stacks it in its corner with the map's buttons; it
// sits first in the corner, above them. The video exporter hides it and draws its own clock,
// sized to the video.

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
    // First in its corner, so the map's buttons stack below (or above, at the bottom) the clock.
    const parent = rootElement.parentElement;
    if (parent && parent.firstChild !== rootElement) parent.insertBefore(rootElement, parent.firstChild);
    if (!this._el || this._el.parentElement !== rootElement) {
      rootElement.textContent = '';
      this._el = document.createElement('div');
      this._el.title = 'Date and time in the data';
      this._el.style.cssText = 'padding:6px 12px;' + THEME_SURFACE +
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
