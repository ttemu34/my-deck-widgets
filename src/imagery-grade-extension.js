// Colour grading for basemap imagery: brightness, contrast, saturation and warmth, applied in the
// fragment shader of the layer it is added to (ecoscope-workflows-ext-mep puts it on the
// TerrainLayer, so the ground -- its own texture and the imagery draped onto it -- is graded while
// tracks, markers and labels keep the colours their legend shows).
//
// The settings are compiled into the shader as constants: they are fixed for a page, so there are no
// uniforms to plumb, and each distinct look is its own small shader variant.
//
// pydeck: extensions=[{"@@type": "ImageryGradeExtension", "saturation": 1.1, ...}]

import { LayerExtension } from '@deck.gl/core';

const DEFAULTS = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };

function num(v, fallback) {
  const x = Number(v);
  return isFinite(x) ? x : fallback;
}
function glsl(x) {
  const s = String(Math.round(x * 10000) / 10000);
  return s.indexOf('.') >= 0 || s.indexOf('e') >= 0 ? s : s + '.0';
}

export class ImageryGradeExtension extends LayerExtension {
  constructor(opts) {
    super(Object.assign({}, DEFAULTS, opts || {}));
  }

  // deck.gl calls this with `this` as the layer and the extension as the argument.
  getShaders(extension) {
    const o = (extension && extension.opts) || DEFAULTS;
    const b = num(o.brightness, 1), c = num(o.contrast, 1), s = num(o.saturation, 1), w = num(o.warmth, 0);
    return {
      inject: {
        'fs:#decl': `
vec3 imageryGrade_apply(vec3 col) {
  col *= ${glsl(b)};                                             // brightness
  col = (col - 0.4) * ${glsl(c)} + 0.4;                          // contrast, pivoting near savanna imagery's mean
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, ${glsl(s)});                         // saturation
  col += vec3(0.05, 0.012, -0.05) * ${glsl(w)};                  // warmth: towards amber, away from blue
  return clamp(col, 0.0, 1.0);
}
`,
        'fs:DECKGL_FILTER_COLOR': 'color.rgb = imageryGrade_apply(color.rgb);'
      }
    };
  }
}

ImageryGradeExtension.extensionName = 'ImageryGradeExtension';
ImageryGradeExtension.defaultProps = {};

// One instance per look, so deck sees the same extension on every render (and compiles it once).
const instances = {};
export function gradeExtension(grade) {
  if (!grade) return null;
  const key = JSON.stringify(grade);
  if (!instances[key]) instances[key] = new ImageryGradeExtension(grade);
  return instances[key];
}
