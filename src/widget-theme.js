// deck.gl's widget theme (@deck.gl/widgets CSS variables), so this library's hand-built UI -- the
// playback bar, Camera panel, map hint and notes -- matches deck's own buttons and follows any theme
// the page sets (ecoscope-workflows-ext-mep's draw_animated_map sets a dark one). The fallbacks are
// the dark look these widgets had before they read the theme.

// A button bar or small floating note: deck's button colours.
export const THEME_SURFACE =
  'background:var(--button-background, rgba(20,20,20,0.72));color:var(--button-text, #fff);' +
  'border-radius:var(--button-corner-radius, 8px);box-shadow:var(--button-shadow, none);' +
  'backdrop-filter:var(--button-backdrop-filter, none);-webkit-backdrop-filter:var(--button-backdrop-filter, none);';

// A larger panel of controls: deck's menu colours.
export const MENU_SURFACE =
  'background:var(--menu-background, rgba(20,20,20,0.85));color:var(--menu-text, #fff);' +
  'border:var(--menu-border, none);border-radius:var(--button-corner-radius, 8px);' +
  'box-shadow:var(--menu-shadow, var(--button-shadow, none));' +
  'backdrop-filter:var(--menu-backdrop-filter, none);-webkit-backdrop-filter:var(--menu-backdrop-filter, none);';
