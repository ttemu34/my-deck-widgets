// deck.gl's TerrainLayer with its own texture colour graded (ImageryGradeExtension) and smooth
// lighting. Imagery draped onto it is blended in after this, so DrapedTileLayer takes the same `grade`
// for its tiles; tracks, markers and labels keep the colours their legend shows.
//
// Smooth lighting: each tile's mesh gets vertex normals as it loads (terrain-normals.js), so a lit
// terrain (`material`) shades the ground smoothly instead of showing every triangle as a facet.
//
// A layer rather than a bare extension because pydeck converts the deck JSON once before this
// library has loaded: an unknown layer type is just skipped on that pass, but an unknown extension
// inside a TerrainLayer's `extensions` turns into null and breaks deck.
//
// pydeck: Layer("GradedTerrainLayer", ...TerrainLayer props..., grade={brightness, contrast, saturation, warmth})

import { TerrainLayer } from '@deck.gl/geo-layers';
import { gradeExtension } from './imagery-grade-extension';
import { addSmoothNormals } from './terrain-normals';

export class GradedTerrainLayer extends TerrainLayer {
  constructor(...propObjects) {
    const props = Object.assign({}, ...propObjects.filter(Boolean));
    const ext = gradeExtension(props.grade);
    if (ext) props.extensions = (props.extensions || []).concat([ext]);
    super(props);
  }

  loadTerrain(opts) {
    const mesh = super.loadTerrain(opts);
    if (!mesh || !this.props.smoothShading || !this.props.material || !this.state.isTiled) return mesh;
    const unitsPerMeter = this._unitsPerMeter(opts.bounds);
    if (!unitsPerMeter) return mesh;
    return Promise.resolve(mesh).then(function (m) { return addSmoothNormals(m, unitsPerMeter); });
  }

  // Common units in a metre at the middle of a tile (bounds in common units), which is how deck scales
  // the tile's heights when it draws them.
  _unitsPerMeter(bounds) {
    try {
      const viewport = this.context.viewport;
      const lngLat = viewport.unprojectFlat([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
      return viewport.getDistanceScales(lngLat).unitsPerMeter[2];
    } catch (e) {
      return null; // flat shading, as deck.gl draws it
    }
  }
}

GradedTerrainLayer.layerName = 'GradedTerrainLayer';
GradedTerrainLayer.defaultProps = {
  grade: null,          // {brightness, contrast, saturation, warmth}; null -> as served
  smoothShading: true   // vertex normals on each tile, for smooth lighting; false -> deck.gl's flat facets
};
