// A deck.gl Widget that renders a graduated "bubble legend": one circle per
// value, sized in the same screen-pixel scale as the dots on the map, so the
// legend actually shows what a given value looks like rather than just a color.
//
// Plain-DOM widget (no WebGL layer involved) — mirrors how ecoscopeDeckWidgets'
// own LegendWidget builds its HTML by hand in onAdd().

import { Widget } from '@deck.gl/core';

export class SizeLegendWidget extends Widget {
  id = 'size-legend';
  placement = 'bottom-right';
  className = 'my-size-legend-widget';

  constructor(props) {
    super(props);
    this.setProps(props);
  }

  // deck.gl's Widget lifecycle calls this regardless of whether onAdd already
  // built the DOM by hand — required even as a no-op, or it throws at render time.
  onRenderHTML() {}

  onAdd() {
    const element = document.createElement('div');
    element.classList.add('deck-widget', this.className);
    Object.assign(element.style, {
      background: 'white',
      padding: '10px 12px',
      borderRadius: '4px',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
      font: '12px sans-serif',
      color: '#333'
    });

    const { title, values, maxRadius: capR } = this.props;

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.textContent = title;
      titleEl.style.fontWeight = 'bold';
      titleEl.style.marginBottom = '6px';
      element.appendChild(titleEl);
    }

    const rows = document.createElement('div');
    rows.style.display = 'flex';
    rows.style.flexDirection = 'column';
    rows.style.gap = '4px';

    // A hard Math.min(radius, capR) clamp keeps the legend box small, but once
    // every value in the list exceeds capR (common for raw, uncapped readings —
    // e.g. via SizeLegendFromDataframe pointed at a reading column), every
    // circle clamps to the same size and the legend stops showing anything
    // about relative magnitude. Instead scale by area (sqrt of value) against
    // the largest value in *this* legend's own list, so that value maps to
    // capR and everything else is sized proportionally below it — mirroring
    // how ClusteredLabeledScatterplotLayer scales dots on the map itself.
    const minDisplayPx = Math.max(2, capR * 0.2);
    const maxValue = Math.max(1, ...values.map((v) => v.radius));
    const displayRadius = (radius) =>
      minDisplayPx + (capR - minDisplayPx) * Math.sqrt(Math.max(0, radius) / maxValue);
    const boxRadius = Math.max(1, ...values.map((v) => displayRadius(v.radius)));

    // Largest first reads naturally top-to-bottom for a bubble legend.
    [...values]
      .sort((a, b) => b.radius - a.radius)
      .forEach(({ label, radius, color }) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'flex-end';
        row.style.gap = '8px';

        // Every circle sits in a box sized to the largest (clamped) value,
        // bottom-aligned, so smaller circles line up on a shared baseline.
        const swatchBox = document.createElement('div');
        swatchBox.style.width = `${boxRadius * 2}px`;
        swatchBox.style.height = `${boxRadius * 2}px`;
        swatchBox.style.display = 'flex';
        swatchBox.style.alignItems = 'flex-end';
        swatchBox.style.justifyContent = 'center';
        swatchBox.style.flexShrink = '0';

        const circle = document.createElement('div');
        const r = displayRadius(radius);
        circle.style.width = `${r * 2}px`;
        circle.style.height = `${r * 2}px`;
        circle.style.borderRadius = '50%';
        circle.style.background = color || '#ff8c00';
        circle.style.flexShrink = '0';

        swatchBox.appendChild(circle);

        const labelEl = document.createElement('span');
        labelEl.textContent = label;

        row.appendChild(swatchBox);
        row.appendChild(labelEl);
        rows.appendChild(row);
      });

    element.appendChild(rows);
    return element;
  }
}

SizeLegendWidget.defaultProps = {
  title: 'Legend',
  values: [],
  // Matches ClusteredLabeledScatterplotLayerStyle's own cluster_max_radius default.
  maxRadius: 64
};
