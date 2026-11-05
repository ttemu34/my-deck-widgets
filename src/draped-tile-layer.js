// Raster map tiles (imagery, labels) draped over a 3D terrain at their own zoom levels.
//
// deck.gl's TerrainLayer fetches its `texture` at the elevation tile's zoom, so imagery stops where
// the elevation data does (zoom 15 for AWS Terrarium, ~5 m a pixel). This layer is a TileLayer of
// BitmapLayers fitted onto the terrain by deck.gl's TerrainExtension (terrainDrawMode 'drape'), so
// imagery can go to zoom 19 over a zoom-15 mesh, and transparent tiles (place-name labels) can be
// stacked on top. The terrain source is any layer with `operation: 'terrain'` or 'terrain+draw',
// e.g. the TerrainLayer underneath.
//
// pydeck's page doesn't include @deck.gl/extensions, so the extension is loaded on demand
// (deck-modules.js); the layer draws nothing until it arrives, and the TerrainLayer's own texture
// shows meanwhile. TileLayer comes from pydeck's bundle (window.deck).
//
// pydeck: pdk.Layer("DrapedTileLayer", data="https://.../{z}/{y}/{x}", max_zoom=19, ...)

import { CompositeLayer } from '@deck.gl/core';
import { BitmapLayer } from '@deck.gl/layers';
import { resolveDeckClass, getTerrainExtension, loadTerrainExtension } from './deck-modules';
import { gradeExtension } from './imagery-grade-extension';

// Esri's "Map data not yet available" tile: what ArcGIS Online basemaps return (HTTP 200) past the
// deepest imagery for a place, e.g. zoom 19 almost everywhere in East African rangelands. Recognised
// by its exact bytes and dropped, so the terrain's own imagery shows there instead of grey squares.
const PLACEHOLDERS = [{ bytes: 2521, sha256: '9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858' }];

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function isPlaceholder(buffer) {
  const match = PLACEHOLDERS.filter(function (p) { return p.bytes === buffer.byteLength; });
  if (!match.length || !(window.crypto && crypto.subtle)) return false;
  const hex = await sha256Hex(buffer);
  return match.some(function (p) { return p.sha256 === hex; });
}

// One tile image, or null when the server has no tile there (an error, or Esri's placeholder).
async function loadTileImage(tile) {
  if (!tile.url) return null;
  const res = await fetch(tile.url, { signal: tile.signal });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  if (await isPlaceholder(buffer)) return null;
  return createImageBitmap(new Blob([buffer]));
}

export class DrapedTileLayer extends CompositeLayer {
  initializeState() {
    const ready = getTerrainExtension();
    this.state = { extension: ready };
    if (ready) return;
    const self = this;
    loadTerrainExtension().then(function (ext) {
      // State is shared with this layer's later instances, so this re-renders the current one.
      if (self.internalState) self.setState({ extension: ext });
    }, function () {
      console.warn('[DrapedTileLayer] no TerrainExtension; draped tiles are not drawn.');
    });
  }

  // Re-render on view changes too, so the culling height follows the view's lift.
  shouldUpdateState(params) {
    return params.changeFlags.somethingChanged;
  }

  // The height range the tiles sit at, for TileLayer's culling. Without it tiles are picked as if the
  // ground were at sea level; over high ground with the camera looking at a lifted point (see
  // TimelineAnimationWidget's liftToGround) that sea-level footprint is several times wider than
  // the screen, and thousands of zoom-19 tiles get fetched. `zRange` prop, else the view's lift.
  groundRange() {
    if (this.props.zRange) return this.props.zRange;
    const vp = this.context.viewport;
    const z = (vp && vp.position && vp.position[2]) || 0;
    const zr = this.state.zRange;
    if (zr && zr[0] === z) return zr;   // same array while the lift is unchanged: no re-selection
    const next = [z, z];
    this.state.zRange = next;
    return next;
  }

  renderLayers() {
    const TileLayer = resolveDeckClass('TileLayer');
    const extension = this.state.extension;
    if (!TileLayer || !extension || !this.props.data) return null;
    const { data, minZoom, maxZoom, tileSize, opacity, maxRequests } = this.props;
    const grade = gradeExtension(this.props.grade);
    const extensions = grade ? [extension, grade] : [extension];
    return new TileLayer(this.getSubLayerProps({
      id: 'tiles',
      data: data,
      minZoom: minZoom,
      maxZoom: maxZoom,
      tileSize: tileSize,
      opacity: opacity,
      maxRequests: maxRequests,
      zRange: this.groundRange(),
      getTileData: loadTileImage,
      // Keep coarser tiles on screen while finer ones load, so zooming never opens holes.
      refinementStrategy: 'best-available',
      renderSubLayers: function (props) {
        if (!props.data) return null;   // no tile here: the terrain's own texture shows through
        const box = props.tile.boundingBox;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [box[0][0], box[0][1], box[1][0], box[1][1]],
          extensions: extensions,
          terrainDrawMode: 'drape'
        });
      }
    }));
  }
}

DrapedTileLayer.layerName = 'DrapedTileLayer';
DrapedTileLayer.defaultProps = {
  data: { type: 'string', value: '' },   // XYZ URL template, {z}/{x}/{y} (or {y}/{x} for ArcGIS)
  minZoom: 0,
  // Esri World Imagery reaches zoom 18 (~0.6 m) across East African rangelands; 19 is mostly placeholders.
  maxZoom: 18,
  tileSize: 256,
  maxRequests: 6,
  zRange: null,   // [min, max] height in metres of the ground the tiles drape onto; null -> the view's lift
  grade: null,    // colour grading for the tiles (ImageryGradeExtension), as GradedTerrainLayer's; null -> as served
  opacity: { type: 'number', min: 0, max: 1, value: 1 }
};
