// A deck.gl Widget that plays back a TripsLayer over time: a play/pause button
// plus a scrub slider, driving `currentTime` via a requestAnimationFrame loop.
//
// By default it targets every layer instance whose constructor is TripsLayer
// (matched by class name, since deck.gl's own geo-layers bundle is loaded as
// the global `deck` and isn't going through our webpack minifier) — pass
// `layerIds` to restrict it to specific layer ids instead.
//
// Animating means re-deriving each target layer with an updated `currentTime`
// via `new LayerClass({...layer.props, currentTime})` and calling
// `deck.setProps({layers})`. `layer.props` already carries every resolved
// accessor/data prop from the original JSON conversion, and reusing the same
// `id` (spread in from `layer.props`) is what lets deck.gl diff/update the
// layer cheaply instead of tearing it down and rebuilding from scratch.

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
      this._applyTime();
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

      this._applyTime();
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

  _applyTime() {
    if (!this.deck) return;
    const { layerIds } = this.props;
    const currentLayers = this.deck.props.layers || [];

    const nextLayers = currentLayers.map((layer) => {
      if (!layer) return layer;
      const isTarget =
        layerIds && layerIds.length
          ? layerIds.includes(layer.id)
          : layer.constructor && layer.constructor.name === 'TripsLayer';
      if (!isTarget) return layer;

      const LayerClass = layer.constructor;
      return new LayerClass({ ...layer.props, currentTime: this._currentTime });
    });

    this.deck.setProps({ layers: nextLayers });
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
  layerIds: null
};
