// deck.gl's TerrainLayer with its own texture colour graded (ImageryGradeExtension). Imagery draped
// onto it is blended in after this, so DrapedTileLayer takes the same `grade` for its tiles; tracks,
// markers and labels keep the colours their legend shows.
//
// A layer rather than a bare extension because pydeck converts the deck JSON once before this
// library has loaded: an unknown layer type is just skipped on that pass, but an unknown extension
// inside a TerrainLayer's `extensions` turns into null and breaks deck.
//
// pydeck: Layer("GradedTerrainLayer", ...TerrainLayer props..., grade={brightness, contrast, saturation, warmth})

import { TerrainLayer } from '@deck.gl/geo-layers';
import { gradeExtension } from './imagery-grade-extension';

export class GradedTerrainLayer extends TerrainLayer {
  constructor(...propObjects) {
    const props = Object.assign({}, ...propObjects.filter(Boolean));
    const ext = gradeExtension(props.grade);
    if (ext) props.extensions = (props.extensions || []).concat([ext]);
    super(props);
  }
}

GradedTerrainLayer.layerName = 'GradedTerrainLayer';
GradedTerrainLayer.defaultProps = {
  grade: null   // {brightness, contrast, saturation, warmth}; null -> as served
};
