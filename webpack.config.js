const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    // window.myDeckWidgets — this string is the `libraryName` you register in pydeck
    library: 'myDeckWidgets',
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  // Don't bundle deck.gl — pydeck already loads it as the global `deck`.
  // Both entrypoints live on that single global, so both map to 'deck'.
  externals: {
    '@deck.gl/core': 'deck',
    '@deck.gl/layers': 'deck'
  }
};
