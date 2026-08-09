# my-deck-widgets

Custom [deck.gl](https://deck.gl) layers packaged for use with pydeck's
`custom_libraries`, served over [jsDelivr](https://www.jsdelivr.com/) straight
from this GitHub repo — no npm publish required.

Ships `ClusteredLabeledScatterplotLayer`: a `ScatterplotLayer` with each point's
value drawn inside the dot, where points whose dots would overlap on screen merge
into a single dot showing the **sum** of the merged values. Merging is done in
screen space, so it's zoom-aware — dots merge as you zoom out and split as you
zoom in.

## Layout

```
src/
  index.js                              # exports -> keys on window.myDeckWidgets
  clustered-labeled-scatterplot-layer.js
examples/index.html                     # local demo (loads the built bundle)
webpack.config.js                       # UMD build, deck.gl externalised
.github/workflows/release.yml           # build + tagged release on `git push` of a tag
```

The webpack `library` name (`myDeckWidgets`) is the string you register as
`libraryName` in pydeck. Every **named export** in `src/index.js` becomes a key on
that global, and each key is a layer `type` you can reference from Python.

## Develop locally

```bash
npm install
npm run dev        # webpack --watch + a static server on http://localhost:8080
```

Open http://localhost:8080/examples/ to see the demo. Point pydeck at the local
bundle while iterating so you're not fighting any CDN cache:

```python
import pydeck as pdk
pdk.settings.custom_libraries = [
    {"libraryName": "myDeckWidgets",
     "resourceUri": "http://localhost:8080/dist/bundle.js"},
]
```

`npm run build` writes `dist/bundle.js` once; `npm run watch` rebuilds on change.

## Release (so the jsDelivr URL works)

`dist/` is gitignored, so releases are cut by CI. Push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow then builds the bundle, commits it onto the tag, and
creates a GitHub Release. The bundle is served at:

```
https://cdn.jsdelivr.net/gh/<owner>/my-deck-widgets@v0.1.0/dist/bundle.js
```

Register that pinned URL in pydeck:

```python
pdk.settings.custom_libraries = [
    {"libraryName": "myDeckWidgets",
     "resourceUri": "https://cdn.jsdelivr.net/gh/<owner>/my-deck-widgets@v0.1.0/dist/bundle.js"},
]
```

Because tagged jsDelivr URLs are cached permanently and immutably, **shipping a
fix means a new tag** (`v0.1.1`, …) and updating the URL — re-tagging the same
version won't refresh the CDN. Keep the repo **public** so jsDelivr can read it.

## Use the layer from pydeck

The class name is the layer `type`. Accessor props use the `get_*` naming so
pydeck camelCases them (`get_value` → `getValue`) and parses the string as a
deck.gl accessor:

```python
layer = pdk.Layer(
    "ClusteredLabeledScatterplotLayer",
    data=gdf,                       # a GeoDataFrame / GeoJSON (not a URL — see below)
    get_position="geometry.coordinates",
    get_value="value",              # numeric field to sum per cluster
    get_radius=6,
    get_fill_color=[80, 140, 240],
    aggregate=True,
    cluster_padding=1.0,
    scale_text_to_radius=True,
)
```

In the ecoscope stack this is wrapped by the `ClusteredLabeledScatterplotLayerStyle`
model and the `create_clustered_labeled_scatterplot_layer` task.

## Notes & limits

- **Use in-memory data, not `data_url`.** Clustering runs client-side over the
  resolved features; a bare URL isn't fetched-and-clustered by the layer.
- **Clustering is greedy and O(n²)** — fine for tens/low-hundreds of points. For
  thousands, replace `_buildClusters` with
  [supercluster](https://github.com/mapbox/supercluster) (build the index on
  `dataChanged`, call `getClusters(bbox, zoom)` with a `reduce` that sums your
  value). The prop interface stays the same.
- **Externals:** the bundle expects deck.gl to be present as the global `deck`
  (pydeck loads it). Don't bundle deck.gl in.

## Adding more layers

1. Create `src/my-other-layer.js` exporting a deck.gl layer class.
2. Re-export it from `src/index.js`.
3. Reference it from Python by its exported class name.
