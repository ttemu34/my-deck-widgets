// Every named export here becomes a key on window.myDeckWidgets, which is how
// pydeck resolves a layer/widget `type` string against this custom library.
// Add more layers/widgets by exporting them alongside these.
export { ClusteredLabeledScatterplotLayer } from './clustered-labeled-scatterplot-layer';
export { SizeLegendWidget } from './size-legend-widget';
export { AnimationWidget } from './animation-widget';
