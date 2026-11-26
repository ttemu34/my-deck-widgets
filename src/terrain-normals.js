// Smooth vertex normals for a terrain tile's mesh, so lighting blends across its triangles.
//
// deck.gl's terrain meshes come without normals, and SimpleMeshLayer then shades flat: one normal per
// triangle, from screen-space derivatives. Terrain meshes are simplified into long, thin triangles, so
// lit terrain shows them as facets. With a NORMAL attribute the layer interpolates the light instead.
//
// The normals have to be in deck's common space, where the mesh is drawn: a terrain tile's positions are
// x, y in common units and z in metres, and z is scaled by `unitsPerMeter` (the common units in a metre
// at the tile's latitude) when drawn. deck normalises the normal after scaling it by the same factor on
// every axis, so a normal computed from (x, y, z * unitsPerMeter) lights exactly the surface drawn.
//
// The vertical "skirt" walls deck adds along a tile's edges (to hide cracks between tiles) are left out
// of the average, or they would tilt the edge vertices' normals and draw a seam along every tile.

const SKIRT_MAX_UP = 0.05; // a triangle whose normal is within ~3 degrees of horizontal is a skirt wall

export function addSmoothNormals(mesh, unitsPerMeter) {
  const attributes = mesh && mesh.attributes;
  if (!attributes || !attributes.POSITION || attributes.NORMAL || !(unitsPerMeter > 0)) return mesh;
  const p = attributes.POSITION.value;
  const vertexCount = p.length / 3;
  const indices = mesh.indices && mesh.indices.value;
  const corners = indices ? indices.length : vertexCount;
  const sum = new Float32Array(vertexCount * 3);
  const k = unitsPerMeter;

  for (let t = 0; t + 2 < corners; t += 3) {
    const i0 = indices ? indices[t] : t;
    const i1 = indices ? indices[t + 1] : t + 1;
    const i2 = indices ? indices[t + 2] : t + 2;
    const ax = p[i1 * 3] - p[i0 * 3], ay = p[i1 * 3 + 1] - p[i0 * 3 + 1], az = (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * k;
    const bx = p[i2 * 3] - p[i0 * 3], by = p[i2 * 3 + 1] - p[i0 * 3 + 1], bz = (p[i2 * 3 + 2] - p[i0 * 3 + 2]) * k;
    // Cross product: its length is twice the triangle's area, so big triangles weigh more.
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!len || Math.abs(nz) / len < SKIRT_MAX_UP) continue;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // ground faces up, whichever way the triangle winds
    for (const i of [i0, i1, i2]) {
      sum[i * 3] += nx; sum[i * 3 + 1] += ny; sum[i * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    const x = sum[i * 3], y = sum[i * 3 + 1], z = sum[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len) { sum[i * 3] = x / len; sum[i * 3 + 1] = y / len; sum[i * 3 + 2] = z / len; }
    else { sum[i * 3 + 2] = 1; } // only on skirt walls, which face nothing: straight up
  }
  attributes.NORMAL = { value: sum, size: 3 };
  return mesh;
}
