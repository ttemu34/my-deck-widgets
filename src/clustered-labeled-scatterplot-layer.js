// A deck.gl CompositeLayer that draws a ScatterplotLayer with each point's value
// optionally rendered inside the dot via a TextLayer (set textStyle to a falsy value
// to render only the dots, no labels), and merges points whose (clusterMaxRadius-
// capped) dots would touch or overlap on screen into a single dot whose label is the
// SUM of the merged values. A merged dot's on-screen radius counts toward further
// merges, so a chain of touching dots all collapse into one cluster.
//
// Merging happens in screen space each time the zoom changes, so it is inherently
// zoom-aware: dots merge as you zoom out and split back into individuals as you zoom in.

import { CompositeLayer } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';

// pydeck may hand us a GeoJSON FeatureCollection, a plain array of records, or
// (for data_url) a URL string we can't cluster synchronously.
function toFeatureArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.features)) return data.features;
  return [];
}

// Resolve a prop that pydeck may have turned into an accessor function, or that
// may still be a constant (array / number).
function resolve(accessor, datum, info) {
  return typeof accessor === 'function' ? accessor(datum, info) : accessor;
}

// Pull every original dataframe column off a record so the tooltip can show
// "everything on the df that is used to plot", not just the computed cluster
// fields. Handles both a real GeoJSON Feature (properties live under
// `.properties`) and pydeck's flat records (every column sits alongside
// `geometry` on the record itself).
function extractProperties(d) {
  if (!d || typeof d !== 'object') return {};
  const raw = d.properties && typeof d.properties === 'object' ? d.properties : d;
  const { geometry, ...rest } = raw;
  // Never let an undefined column value reach the picked object: deck.gl's
  // default tooltip does JSON.stringify(value).length per property, and
  // JSON.stringify(undefined) is the literal undefined, which has no .length.
  const clean = {};
  for (const key in rest) {
    clean[key] = rest[key] === undefined ? null : rest[key];
  }
  return clean;
}

export class ClusteredLabeledScatterplotLayer extends CompositeLayer {
  // The default shouldUpdateState ignores viewport-only changes; we need to
  // re-cluster on zoom, so opt into "somethingChanged" (includes viewportChanged).
  shouldUpdateState({ changeFlags }) {
    return changeFlags.somethingChanged;
  }

  updateState({ props, oldProps, changeFlags }) {
    // 1) Normalise raw features into flat points once, resolving every accessor
    //    up front so the render path deals only in plain values.
    const getTextColor = props.textStyle?.getTextColor;
    const oldGetTextColor = oldProps.textStyle?.getTextColor;
    const accessorsChanged =
      props.getPosition !== oldProps.getPosition ||
      props.getValue !== oldProps.getValue ||
      props.getRadius !== oldProps.getRadius ||
      props.getFillColor !== oldProps.getFillColor ||
      props.getLineColor !== oldProps.getLineColor ||
      props.getLineWidth !== oldProps.getLineWidth ||
      getTextColor !== oldGetTextColor;

    if (changeFlags.dataChanged || accessorsChanged) {
      const { getPosition, getValue, getRadius, getFillColor, getLineColor, getLineWidth } =
        props;

      const features = toFeatureArray(props.data);
      const points = features.map((d, index) => {
        const info = { index, data: features };
        return {
          position: resolve(getPosition, d, info),
          value: Number(resolve(getValue, d, info)) || 0,
          radius: resolve(getRadius, d, info),
          color: resolve(getFillColor, d, info),
          lineColor: resolve(getLineColor, d, info),
          lineWidth: resolve(getLineWidth, d, info),
          textColor: resolve(getTextColor, d, info),
          properties: extractProperties(d)
        };
      });

      const total = points.reduce((sum, p) => sum + p.value, 0);
      // The theoretical largest a single cluster's radius-accessor sum could ever
      // reach (every point merging into one). Used as a fixed normalization
      // denominator for display radius — see _buildClusters for why it has to
      // stay fixed rather than being computed from the actual clusters formed.
      const totalRadius = points.reduce((sum, p) => sum + (Number(p.radius) || 0), 0);
      this.setState({ points, total, totalRadius, needsCluster: true });
    }

    // 2) Re-cluster whenever the zoom, the toggle, or the padding changes.
    const zoom = this.context.viewport.zoom;
    const zoomChanged = Math.abs(zoom - (this.state.zoom ?? Infinity)) > 1e-3;
    const modeChanged =
      props.aggregate !== oldProps.aggregate ||
      props.clusterPadding !== oldProps.clusterPadding ||
      props.clusterMaxRadius !== oldProps.clusterMaxRadius;

    if (this.state.needsCluster || zoomChanged || modeChanged) {
      this.setState({ clusters: this._buildClusters(), zoom, needsCluster: false });
    }
  }

  _buildClusters() {
    const { aggregate, clusterPadding, clusterMaxRadius } = this.props;
    const { viewport } = this.context;
    const points = this.state.points || [];

    // Aggregation off: one cluster per point (still normalises the shape so the
    // sublayers have a single data schema to read).
    const capR = clusterMaxRadius ?? 64;
    // A hard Math.min(r, capR) clamp collapses every point/cluster whose raw
    // radius-accessor value exceeds capR down to the exact same pixel size —
    // in practice, once a dataset's typical values exceed capR, that's nearly
    // everything, so a 422 reading and a 3022.8 merged sum both render
    // identically and size stops meaning anything. Instead, scale by area
    // (sqrt of value) relative to a fixed reference — the sum of every
    // point's radius value in the current data (totalRadius, from
    // updateState) — so a value's share of that total maps proportionally
    // into [minDisplayPx, capR]. The reference has to stay fixed rather than
    // "the largest cluster actually formed": that would need to be known
    // before clustering runs, which would either require a second pass (and
    // rescaling clusters after the fact could make two dots that were decided
    // to touch during clustering no longer visually touch once redrawn at the
    // new scale) or bias the merge/reach test with a size that doesn't match
    // what's finally drawn — the same touch-vs-merge mismatch fixed earlier.
    const minDisplayPx = Math.max(2, capR * 0.2);
    const totalRadius = this.state.totalRadius || 0;
    const scaleRadius = (raw) => {
      if (totalRadius <= 0) return minDisplayPx;
      const t = Math.min(1, Math.max(0, raw) / totalRadius);
      return minDisplayPx + (capR - minDisplayPx) * Math.sqrt(t);
    };

    if (!aggregate) {
      return points.map((p) => ({
        // Spread first so every original df column is on the tooltip; the
        // computed fields below always win if a column happens to share a name.
        ...p.properties,
        position: p.position,
        value: p.value,
        count: 1,
        displayRadius: scaleRadius(p.radius),
        color: p.color ?? [80, 140, 240, 255],
        lineColor: p.lineColor ?? [255, 255, 255, 60],
        lineWidth: p.lineWidth ?? 1,
        textColor: p.textColor ?? [20, 20, 20, 255]
      }));
    }

    const pad = clusterPadding ?? 1;

    // Project every point to pixels; two dots collide once their (capped) radii
    // would touch or overlap on screen.
    const proj = points.map((p) => {
      const s = viewport.project(p.position);
      return { p, sx: s[0], sy: s[1], used: false };
    });

    const clusters = [];
    for (let i = 0; i < proj.length; i++) {
      const anchor = proj[i];
      if (anchor.used) continue;
      anchor.used = true;

      let sum = anchor.p.value;
      let radiusSum = anchor.p.radius;
      let count = 1;
      let cx = anchor.sx;
      let cy = anchor.sy;
      // The cluster's current on-screen radius — grows (via radiusSum) as it
      // absorbs points, so an already-merged cluster can keep reaching out to
      // touch further ones, and the final size reflects its true combined mass.
      let maxRadius = scaleRadius(radiusSum);
      // Every original df row folded into this cluster, so the tooltip can show
      // "everything on the df" even once points have merged.
      const mergedProperties = [anchor.p.properties];

      for (let j = i + 1; j < proj.length; j++) {
        const other = proj[j];
        if (other.used) continue;
        const dx = anchor.sx - other.sx;
        const dy = anchor.sy - other.sy;
        const otherRadius = scaleRadius(other.p.radius);
        const reach = (maxRadius + otherRadius) * pad;
        if (dx * dx + dy * dy <= reach * reach) {
          other.used = true;
          sum += other.p.value;
          count += 1;
          cx += other.sx;
          cy += other.sy;
          mergedProperties.push(other.p.properties);
          radiusSum += other.p.radius;
          maxRadius = scaleRadius(radiusSum);
        }
      }

      cx /= count;
      cy /= count;
      const world = viewport.unproject([cx, cy]);

      clusters.push({
        // A single, unmerged point: spread its own df row directly so the
        // tooltip reads exactly like that row. A real merge folds several rows
        // together, so there's no single row to spread — surface all of them
        // instead under mergedRows rather than picking one arbitrarily.
        ...(count === 1 ? mergedProperties[0] : { mergedRows: mergedProperties }),
        position: [world[0], world[1]],
        value: sum,
        count,
        // Reflects radiusSum's share of the fixed totalRadius reference — a
        // cluster summing several large readings renders visibly bigger than
        // any one of its members, instead of every large value/cluster
        // pinning to the same capR ceiling.
        displayRadius: maxRadius,
        // merged dots keep the same colour as an individual point — no visual
        // distinction between a cluster and a single reading.
        //
        // These fall back to a real value (never undefined): a cluster is also
        // deck.gl's default pick/hover object, and its default tooltip formatter
        // does JSON.stringify(value).length on every property — undefined has no
        // .length and throws, which can stall deck.gl's redraw loop entirely.
        color: anchor.p.color ?? [80, 140, 240, 255],
        lineColor: anchor.p.lineColor ?? [255, 255, 255, 60],
        lineWidth: anchor.p.lineWidth ?? 1,
        textColor: anchor.p.textColor ?? [20, 20, 20, 255]
      });
    }
    return clusters;
  }

  renderLayers() {
    const {
      radiusUnits,
      radiusScale,
      radiusMinPixels,
      radiusMaxPixels,
      lineWidthUnits,
      lineWidthScale,
      lineWidthMinPixels,
      lineWidthMaxPixels,
      stroked,
      filled,
      textStyle
    } = this.props;

    const clusters = this.state.clusters || [];

    const circles = new ScatterplotLayer(
      this.getSubLayerProps({
        id: 'circles',
        data: clusters,
        getPosition: (d) => d.position,
        getRadius: (d) => d.displayRadius,
        getFillColor: (d) => d.color,
        getLineColor: (d) => d.lineColor || [255, 255, 255, 60],
        getLineWidth: (d) => d.lineWidth ?? 1,
        radiusUnits,
        radiusScale,
        radiusMinPixels,
        radiusMaxPixels: radiusMaxPixels ?? Number.MAX_SAFE_INTEGER,
        lineWidthUnits,
        lineWidthScale,
        lineWidthMinPixels,
        lineWidthMaxPixels: lineWidthMaxPixels ?? Number.MAX_SAFE_INTEGER,
        stroked: stroked ?? true,
        filled: filled ?? true,
        updateTriggers: { getRadius: clusters, getFillColor: clusters }
      })
    );

    // No text_style at all (Python side passed None) means: dots only, no labels.
    if (!textStyle) {
      return [circles];
    }

    const {
      textSize,
      scaleTextToRadius,
      sizeUnits,
      fontFamily,
      fontWeight,
      getTextAnchor,
      getAlignmentBaseline,
      outlineWidth,
      outlineColor
    } = textStyle;

    // Whole numbers print as-is (no trailing ".0"); anything else rounds to 1dp.
    const formatValue = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const getTextFor = (d) => formatValue(d.value);

    // A font size that looks right for "21.6" can easily be wider than the dot
    // itself once the value is "100000" — shrink the font so the label's text
    // width never exceeds the circle's diameter, on top of whatever size the
    // radius-scaling (or fixed textSize) would otherwise give.
    const CHAR_WIDTH_RATIO = 0.62; // approx monospace glyph advance width per em
    const TEXT_FIT_PADDING = 0.85; // fraction of the diameter usable for text
    const sizeFor = (d) => {
      const base = scaleTextToRadius ? Math.max(9, d.displayRadius * 0.62) : textSize ?? 12;
      const text = getTextFor(d);
      const maxWidth = d.displayRadius * 2 * TEXT_FIT_PADDING;
      const widthLimited = maxWidth / Math.max(1, text.length * CHAR_WIDTH_RATIO);
      return Math.max(6, Math.min(base, widthLimited));
    };

    const labels = new TextLayer(
      this.getSubLayerProps({
        id: 'labels',
        data: clusters,
        getPosition: (d) => d.position,
        getText: getTextFor,
        getColor: (d) => d.textColor || [20, 20, 20, 255],
        getSize: sizeFor,
        sizeUnits: sizeUnits || 'pixels',
        getTextAnchor: getTextAnchor || 'middle',
        getAlignmentBaseline: getAlignmentBaseline || 'center',
        fontFamily: fontFamily || 'Monaco, monospace',
        fontWeight: fontWeight || 'normal',
        // enable an SDF atlas only when an outline is requested (readability)
        fontSettings: outlineWidth ? { sdf: true } : {},
        outlineWidth: outlineWidth ?? 0,
        outlineColor: outlineColor ?? [255, 255, 255, 255],
        updateTriggers: {
          getSize: [scaleTextToRadius, textSize],
          getText: clusters,
          getColor: clusters
        }
      })
    );

    return [circles, labels];
  }
}

ClusteredLabeledScatterplotLayer.layerName = 'ClusteredLabeledScatterplotLayer';

ClusteredLabeledScatterplotLayer.defaultProps = {
  // clustering
  aggregate: true,
  clusterPadding: 1.0,
  clusterMaxRadius: { type: 'number', value: 64 },

  // accessors (pydeck turns the get_* strings into these functions)
  getPosition: { type: 'accessor', value: (d) => d.geometry?.coordinates ?? d.position },
  getValue: { type: 'accessor', value: 0 },
  getRadius: { type: 'accessor', value: 5 },
  getFillColor: { type: 'accessor', value: [80, 140, 240, 255] },
  getLineColor: { type: 'accessor', value: [255, 255, 255, 60] },
  getLineWidth: { type: 'accessor', value: 1 },

  // scatter styling
  radiusUnits: 'pixels',
  radiusScale: 1,
  radiusMinPixels: 0,
  radiusMaxPixels: undefined,
  lineWidthUnits: 'pixels',
  lineWidthScale: 1,
  lineWidthMinPixels: 0,
  lineWidthMaxPixels: undefined,
  stroked: true,
  filled: true,

  // Style for the value labels drawn on each dot. Defaults to null (no labels) —
  // "labels on by default" is provided by the Python side always sending a real
  // text_style object unless the caller explicitly passes text_style=None. Pydeck
  // and pydantic's exclude_none both drop None-valued kwargs entirely, so an absent
  // key is indistinguishable from "never configured" — this default must stay null,
  // or a falsy/missing textStyle could never mean "off" once merged with defaultProps.
  textStyle: { type: 'object', value: null }
};
