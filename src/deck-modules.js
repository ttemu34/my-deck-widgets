// deck.gl modules that pydeck's page doesn't include (e.g. @deck.gl/extensions), loaded on demand.
//
// deck.gl's standalone module bundles replace window.deck with only their own exports, so they are
// loaded one at a time, the module handed back, and the full namespace restored. They come from
// unpkg at the page's deck.gl version rather than being bundled here: a bundled copy could drift
// from the deck.gl that pydeck loads. Shared by every widget and layer in this library, so two of
// them loading at once can't trample window.deck, and each module is fetched once.

let chain = Promise.resolve();
const cache = {};

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

export function loadDeckModule(pkg) {
  if (cache[pkg]) return cache[pkg];
  const run = async function () {
    const prev = window.deck;
    const ver = (prev && prev.VERSION) || 'latest';
    try {
      await loadScript('https://unpkg.com/' + pkg + '@' + ver + '/dist.min.js');
      return window.deck;
    } finally {
      window.deck = prev;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(function () {});
  cache[pkg] = p;
  p.catch(function () { delete cache[pkg]; });   // a failed load can be retried
  return p;
}

// A deck.gl class by name from the page's namespace (pydeck's bundle), or null.
export function resolveDeckClass(name) {
  const cands = [window.deck, window.deckgl, window.DeckGL];
  for (const ns of cands) {
    if (ns && typeof ns[name] === 'function') return ns[name];
  }
  return null;
}
