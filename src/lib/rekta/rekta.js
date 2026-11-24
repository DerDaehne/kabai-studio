/*!
 * Rekta Design, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.
 * Source: https://github.com/DerDaehne/Rekta-Design
 * Commit: 1116956c67ed9d34a90a0bed18e1046ebdb3366e
 * Tag: v0.6.0
 * Generator: scripts/build.mjs of Rekta Design
 * Output: dist/rekta.js
 * SHA-256 of everything below this header: 2a6f5ac3bdd4c3a957ec629ced8b5b47978a53d0b6d90ec8fc9743d858be87b4
 * License: MIT, Copyright (c) 2026 DerDaehne; full text in NOTICE.
 * Notice: some token values derive from the Porsche Design System source code (Apache License 2.0).
 * No Porsche fonts, icons, assets or marks are included.
 */
/* Rekta Design behaviour. A framework-free ES module with no dependencies.

   Every timing and angle comes from the --rk- tokens, so reduced motion (every motion duration 0s) makes each step
   instant, never skipped. State the script writes lives in data-rk-* attributes and --_rk-* properties, never in
   classes, so a framework that owns className keeps working. Each controller returns { destroy() }.

   The parts:
     prefs      theme, density, motion, contrast, transparency and accent switches on the root element, remembered per
                user
     keys       one layered keyboard dispatcher: the innermost thing that owns a key gets it (Escape, Ctrl/Cmd+Z)
     press      tiles nudge back where they are pressed; dragging or selecting text never activates them
     turn       the place change (turnstile) as two primitives, leave() and enter(), any router can call
     places     a small router for places mounted in the page: URLs, history, back, titles, focus
     panorama   sideways sections: one wheel gesture latches to one scroller, keyboard jumps, the pivot follows
     pivot      facets of a place: fixed order, glide, keyboard
     toaster    one toast at a time, with an undo window that holds while hovered or focused
     banner     one lasting system state at a time, the most severe first
     sheet      a short question from the top edge; a tap on the shading cancels
     busy       a data region loads: the line after busy-delay, never a flash
     pending    a button's action runs: it says what it is doing, at the same width
     menu       a menu button with a floating list, placed next to its control
     select     Metro selection: a click selects and shows, Ctrl/Cmd+click starts the selection mode
     table      sorting, selection, labels for the stacked layout
     split      a list and its current item: a draggable divider sideways, one pane at a time compact
     palette    go to a place or run a command, from a list that rises from the app bar (Ctrl/Cmd+K)
     appbar     controls that do not fit move into a "more" menu
     form       late checks, early corrections, a summary of what needs attention, server answers at the field
     guard      unsaved input asks before it is left behind
     confirm    a short question in a sheet, the safe answer first
     disable    a control that cannot act now says why
     tips       a short ink label for a control, after a rest of the pointer or on keyboard focus
     contextMenu a menu where the pointer is: a right click, a long press, Shift+F10
     grid       a grid of tiles that open is one tab stop; the arrows move to the nearest tile that way
     tree       a hierarchy that opens and closes, one tab stop
     sortable   items reordered by their grip, with the pointer or the keyboard
     virtual    a list of any length: only the rows in view exist
     undoStack  actions that can be taken back and done again (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z)
     live       a live region says how fresh it is, goes stale, and holds still while you look
     chart      a line or bar chart in ink and grey: one axis, a tooltip at every point, a table of the numbers
     icon       an icon from the sprite, decoration or an image with a name
     titlebar   the title bar of an installed app: the drag area, back, the place's name
     pwa        installable and offline: the service worker, the update toast, install()
     reflow     FLIP: what a change moves or resizes glides there (a tile resized, a grid re-flowed)
     enter, leave, presence   things arrive in and leave a list or a grid; the rest close the gap
     tileUpdate a live tile has news: the new number peeks up, a new status flips the tile
     nudge      a part whose gesture nobody can see (a swipe) hints at it when it is only tapped
     sparkTo    a live line moves to its new points
     crossfade  a change of the whole look fades instead of flipping
     combobox   a field with a list of choices that filters as you type
     stepper    a number field between − and +, repeating while held
     drop       a zone that takes dropped or chosen files
     strings    every word the script shows or says, English unless a product sets its own; locale() and number()
     start      the defaults for a page: prefs, press, sheets, steppers, sliders, switches, arrival build-in, words
     tokens     token values as they apply right now (theme, density, reduced motion) */

export const version = '0.6.0';

// Tokens -------------------------------------------------------------------------------------------------------------
// The document's root, looked up when used: importing the module touches no DOM, so it loads during server rendering.
const docEl = () => document.documentElement;
function css(name, el = docEl()) { return getComputedStyle(el).getPropertyValue(name).trim(); }
function ms(name, el) { const v = css(name, el); return (parseFloat(v) || 0) * (/ms$/.test(v) ? 1 : 1000); }
function num(name, el) { return parseFloat(css(name, el)) || 0; }
// A length token in px, whatever unit it is written in (rem follows the root's font size).
// A length token in px, whatever it is written as: px and rem directly, anything else (calc(), a var() of a calc(), em)
// through an element sized by it, so a product's override in any length form reads right.
function px(name, el) {
  const v = css(name, el);
  if (/^-?[\d.]+(px)?$/.test(v)) return parseFloat(v);
  if (/^-?[\d.]+rem$/.test(v)) return parseFloat(v) * (parseFloat(getComputedStyle(docEl()).fontSize) || 16);
  if (!v) return 0;
  const host = el && el.isConnected ? el : document.body, probe = document.createElement('span');
  probe.dataset.rkProbe = '';
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:var(${name});height:0;padding:0;border:0`;
  host.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w || 0;
}

// Words and numbers -------------------------------------------------------------------------------------------------
// Every word rekta.js shows or says comes from strings, English by default. start({ locale, strings }) or
// setStrings({ ... }) replaces any of them: a value is a string, or a function of the same arguments returning one.
// An entry that counts (COUNT_ARG names the argument) is a set of plural forms, { one, few, many, other, ... }, picked
// with Intl.PluralRules for the locale; each form is a string or a function of the same arguments.
// Numbers and times follow the locale (start's, else the document's lang, else the browser's).
// rk-strings-begin
export const strings = {
  undo: 'undo', redo: 'redo', ok: 'ok', cancel: 'cancel', live: 'live', since: 'since', any: 'any', field: 'field',
  noValue: 'no value', reload: 'reload',
  undoWindow: { one: (seconds, again) => `, 1 second to${again ? ' undo' : ''}`, other: (seconds, again) => `, ${seconds} seconds to${again ? ' undo' : ''}` },
  bannerStill: (event, word) => `${event}. The banner keeps showing “${word}” until that ends.`,
  chosen: (summary, chosen) => `${summary}: ${chosen}`,
  selected: { one: (n) => `${n} selected`, other: (n) => `${n} selected` },
  columnWidth: (column) => `width of ${column}`,
  cellRefused: 'That value was not taken.',
  paletteEmpty: (query) => `Nothing to go to or run matches “${query}”.`,
  saveFailed: 'Could not save. Try again.',
  guardWhat: 'This form',
  guardKicker: 'unsaved',
  guardTitle: 'Leave without saving?',
  guardText: { one: (what) => `${what} has 1 unsaved change.`, other: (what, n) => `${what} has ${n} unsaved changes.` },
  guardDiscard: 'discard changes',
  guardKeep: 'keep editing',
  discardTitle: 'Discard what you entered?',
  move: (item) => `move ${item}`,
  inBack: (name) => `back · ${name}`,
  nothingToUndo: 'Nothing to undo.',
  undone: (what) => `Undone: ${what}`,
  justNow: 'just now',
  secondsAgo: (s) => `${s} s ago`,
  minutesAgo: (m) => `${m} min ago`,
  at: (time) => `at ${time}`,
  updated: (ago) => `updated ${ago}`,
  heldUpdated: (ago) => `held while you look · updated ${ago}`,
  staleFor: (s, m, time) => `stale · no update for ${s < 60 ? `${s} s` : m < 60 ? `${m} min` : `since ${time}`}`,
  offlineSince: (ago) => `offline · last update ${ago}`,
  updatesWaiting: { one: '1 update waiting · show', other: (n) => `${n} updates waiting · show` },
  chartName: (type, series, from, to) => `${type === 'bars' ? 'Bar' : 'Line'} chart of ${series.join(' and ')}, ${from} to ${to}. Use the arrow keys to read each value; a table follows.`,
  chartNumbers: 'show the numbers',
  installed: 'Installed. It opens in a window of its own.',
  newVersion: 'A new version is ready.',
  noMatch: (query) => `Nothing matches “${query}”.`,
  nothingYet: 'Nothing to choose yet.',
  needAttention: { one: '1 field needs attention', other: (n) => `${n} fields need attention` },
  pickedUp: (item, at, of) => `${item} picked up, position ${at} of ${of}. ↑ ↓ to move, Space to put down, Escape to put back.`,
  putDown: (item, at, of) => `${item} put down at position ${at} of ${of}.`,
  putBack: (item) => `${item} put back.`,
  position: (item, at, of) => (item ? `${item}: position ${at} of ${of}.` : `position ${at} of ${of}`),
  loadFailed: 'Could not load the choices. Type to try again.',
  keyMeta: (os) => (os === 'windows' ? 'Win' : 'Super'),
  cannotAct: (label, reason) => `${label} (${reason})`,
  back: 'back',
};
// rk-strings-end
const COUNT_ARG = { undoWindow: 0, selected: 0, guardText: 1, updatesWaiting: 0, needAttention: 0 };
const DEFAULT_STRINGS = { ...strings };
let localeSet = '';
// setStrings(partial): replaces those words; setStrings(null) gives back the English ones.
export function setStrings(partial) { if (partial === null) Object.assign(strings, DEFAULT_STRINGS); else Object.assign(strings, partial); }
export function setLocale(tag) { localeSet = tag || ''; }
export function locale() { return localeSet || (typeof document !== 'undefined' && document.documentElement.lang) || (typeof navigator !== 'undefined' && navigator.language) || 'en'; }
function plural(n) { try { return new Intl.PluralRules(locale()).select(n); } catch { return n === 1 ? 'one' : 'other'; } }
function tx(key, ...args) {
  let v = strings[key];
  if (v && typeof v === 'object') { const n = Number(args[COUNT_ARG[key] || 0]); v = v[plural(n)] ?? v.other; }
  return typeof v === 'function' ? v(...args) : v === undefined ? key : String(v);
}
// number(v): a figure for a chart, a tooltip or a table: compact from a thousand up (1.2K, 1200 in German), in the
// locale's digits and separators.
export function number(v, { compact = true } = {}) {
  if (!Number.isFinite(v)) return String(v);
  const big = compact && Math.abs(v) >= 1e3;
  try { return new Intl.NumberFormat(locale(), big ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(v); }
  catch { return String(+v.toFixed(2)); }
}
function clock(date) { try { return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date); } catch { return date.toTimeString().slice(0, 5); } }
function bezier(name) {
  const m = /cubic-bezier\(([^)]+)\)/.exec(css(name));
  const [x1, y1, x2, y2] = m ? m[1].split(',').map(Number) : [0.25, 0.1, 0.25, 1];
  // Solve x(t) = x for t by Newton-Raphson, then return y(t), like a browser's own timing function.
  const a = (u, v) => 1 - 3 * v + 3 * u, b = (u, v) => 3 * v - 6 * u, c = (u) => 3 * u;
  const sx = (t) => ((a(x1, x2) * t + b(x1, x2)) * t + c(x1)) * t, sy = (t) => ((a(y1, y2) * t + b(y1, y2)) * t + c(y1)) * t;
  const dx = (t) => 3 * a(x1, x2) * t * t + 2 * b(x1, x2) * t + c(x1);
  return (x) => { let t = x; for (let i = 0; i < 8; i += 1) { const e = sx(t) - x; if (Math.abs(e) < 1e-4) break; const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; } return sy(Math.min(1, Math.max(0, t))); };
}
// Read a token where it applies: tokens.value('--rk-accent'), tokens.ms('--rk-duration-short') (0 under reduced
// motion), tokens.number('--rk-space-m').
export const tokens = { value: css, ms, number: num, px };
const openLayer = (sel) => { try { return !!document.querySelector(sel); } catch { return false; } };
const later = (fn, wait) => (wait > 0 ? setTimeout(fn, wait) : (queueMicrotask(fn), 0));
const isEditable = (t) => !!t && (t.isContentEditable || (t.matches && t.matches('textarea, select, input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=button], [type=submit], [type=reset], [type=image])')));
// Type-ahead (docs/navigation.md): in a collection whose entries take focus, a letter or digit goes to the next entry
// whose text starts with it. Letters typed less than timing.type-ahead apart form a prefix ("mar" after "may"); the
// same letter again moves on to the next entry with it. Never in a text field: where there is a field, typing filters.
// typeAhead() keeps one collection's typing and returns find(e, entries, current, textOf): the entry to go to, or null
// when the key is not one it takes or nothing starts so. Entries may be elements or anything textOf reads (an index).
function typeAhead() {
  let typed = '', at = 0;
  return (e, entries, current, textOf = (x) => x.textContent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || !/^[\p{L}\p{N}]$/u.test(e.key)) return null;
    const now = Date.now();
    typed = now - at < (ms('--rk-duration-type-ahead') || 1000) ? typed + e.key.toLowerCase() : e.key.toLowerCase();
    at = now;
    const again = [...typed].every((c) => c === typed[0]), want = again ? typed[0] : typed, i = entries.indexOf(current);
    // A first letter, or the same one again, looks past the current entry; a longer prefix may still be the current one.
    const from = again ? i + 1 : Math.max(0, i), order = [...entries.slice(from), ...entries.slice(0, from)];
    return order.find((x) => String(textOf(x)).replace(/\s+/g, ' ').trim().toLowerCase().startsWith(want)) ?? null;
  };
}
function animateScroll(el, to, duration, ease) {
  cancelAnimationFrame(el._rkRaf);
  const from = el.scrollLeft;
  if (!duration || Math.abs(from - to) < 1) { el.scrollTo({ left: to, behavior: 'instant' }); return; }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    el.scrollTo({ left: from + (to - from) * ease(t), behavior: 'instant' });
    el._rkRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  el._rkRaf = requestAnimationFrame(step);
}
// Where focus goes when the element it should return to is gone: start({ focusFallback }), then a shown
// [data-rk-focus-fallback], the shown place's title, the page's h1, main.
let fallbackFocus = null;
function fallbackTarget() {
  const shownFirst = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length && !e.closest('[hidden], [inert]')) || null;
  return (fallbackFocus && fallbackFocus()) || shownFirst('[data-rk-focus-fallback]') || shownFirst('.rk-place:not([hidden]) .rk-title')
    || shownFirst('main h1') || shownFirst('h1') || document.querySelector('main');
}
function returnFocus(from) {
  const t = from && from.isConnected && !from.closest('[hidden]') ? from : fallbackTarget();
  if (!t) return;
  if (!t.hasAttribute('tabindex') && !t.matches('a[href], button, input, select, textarea, summary')) t.setAttribute('tabindex', '-1');
  t.focus();
}
function focusHeading(scope) {
  const h = scope && scope.querySelector('.rk-title, .rk-group, h1, h2, h3');
  if (!h) return null;
  if (!h.hasAttribute('tabindex') && !h.matches('a, button, input, select, textarea')) h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
  return h;
}

// Prefs --------------------------------------------------------------------------------------------------------------
// theme: system | light | dark; density: auto | comfortable | compact; motion: system | on | off; contrast: system |
// more | normal (more: every text pair at 7:1, a frame on status tiles); transparency: system | reduce | normal
// (reduce: glass is the ground, nothing blurs); accent: product | a named accent (ink, teal, steel, violet, mauve,
// pink, magenta: tokens/rekta.accents.json, which rekta.tokens.css carries as [data-accent]). The default removes the
// attribute, so the system setting (or the pointer, for density; the product's own --rk-accent, for the accent)
// decides. Set them before first paint.
const PREF_DEFAULT = { theme: 'system', density: 'auto', motion: 'system', contrast: 'system', transparency: 'system', accent: 'product' };
export const prefs = {
  key: 'rekta-prefs',
  read() { try { return JSON.parse(localStorage.getItem(this.key) || '{}'); } catch { return {}; } },
  write(all) { try { localStorage.setItem(this.key, JSON.stringify(all)); } catch { /* private mode: this visit only */ } },
  get(name) { return docEl().dataset[name] || PREF_DEFAULT[name]; },
  set(name, value, { remember = true } = {}) {
    if (!(name in PREF_DEFAULT)) throw new Error(`unknown pref ${name}`);
    const commit = () => {
      if (!value || value === PREF_DEFAULT[name]) delete docEl().dataset[name]; else docEl().dataset[name] = value;
      if (remember) { const all = this.read(); all[name] = this.get(name); this.write(all); }
      document.dispatchEvent(new CustomEvent('rk:prefs', { detail: { name, value: this.get(name) } }));
    };
    // A theme, contrast or accent chosen by the user cross-fades (view transitions); a restored one applies before the
    // first paint.
    if ((name === 'theme' || name === 'contrast' || name === 'accent') && remember && this.get(name) !== (value || PREF_DEFAULT[name])) crossfade(commit);
    else commit();
  },
  restore() { const all = this.read(); for (const name of Object.keys(PREF_DEFAULT)) if (all[name]) this.set(name, all[name], { remember: false }); },
};

// Keys ---------------------------------------------------------------------------------------------------------------
// The innermost layer that wants a key gets it. Higher priority first: floating surfaces 40, a focused toast 30,
// a selection 20, the place (back) 10. A handler returns true when it used the key; it is then prevented.
const layers = [];
let keysBound = false;
function onKey(e) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  for (const layer of layers) {
    if (layer.fn(e)) { e.preventDefault(); return; }
  }
}
export const keys = {
  on(priority, fn) {
    const layer = { priority, fn };
    layers.push(layer); layers.sort((a, b) => b.priority - a.priority);
    if (!keysBound) { document.addEventListener('keydown', onKey); keysBound = true; }
    return () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); };
  },
  // Escape may go back to the previous place only when nothing nearer wants it.
  escapeIsFree(e) {
    const t = e.target;
    if (isEditable(t)) return false;
    if (t.closest && t.closest('[role=combobox], [role=listbox], [role=menu], [aria-expanded=true]')) return false;
    if (openLayer(':modal') || openLayer(':popover-open')) return false;
    return true;
  },
  isEditable,
};

// Press --------------------------------------------------------------------------------------------------------------
// A tile nudges back where it is pressed. On touch it presses only after tap-delay without movement, so the start of a
// scroll never sinks it. Movement past 4px (8px on touch) releases it, and a click that follows a drag or a text
// selection inside the tile is cancelled: dragging never activates. A quick tap still shows the whole sink.
// Tiles that open something, and anything marked data-rk-press (a selectable row or entry, which tilts less).
const TILE = 'a.rk-tile, button.rk-tile, [data-rk-press]';
const CONTROL = 'button, input, select, textarea, label, summary';
const pressState = { pressed: null, last: null, since: 0, letGo: 0, lettingGo: null };
function setPressed(tile, x, y) {
  releasePress(true);
  tile.style.setProperty('--_rk-px', x.toFixed(3));
  tile.style.setProperty('--_rk-py', y.toFixed(3));
  tile.setAttribute('data-rk-pressed', '');
  Object.assign(pressState, { pressed: tile, last: tile, since: performance.now() });
}
function dropPress() {
  clearTimeout(pressState.letGo);
  if (pressState.lettingGo) pressState.lettingGo.removeAttribute('data-rk-pressed');
  pressState.lettingGo = null;
}
function releasePress(now) {
  if (now) dropPress();
  const tile = pressState.pressed;
  if (!tile) return;
  const wait = now ? 0 : Math.max(0, ms('--rk-duration-press') - (performance.now() - pressState.since));
  pressState.pressed = null;
  dropPress();
  if (!wait) { tile.removeAttribute('data-rk-pressed'); return; }
  pressState.lettingGo = tile;
  pressState.letGo = setTimeout(dropPress, wait);
}
export function press(scope = document) {
  let start = null, pending = 0;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const down = (e) => {
    if (e.button > 0) return;
    const tile = e.target.closest && e.target.closest(TILE);
    // A control inside a row acts on its own; the row does not sink under it.
    const inner = tile && tile.matches('[data-rk-press]') && e.target.closest(CONTROL);
    if (!tile || turn.running || (inner && tile.contains(inner))) { start = null; return; }
    const r = tile.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width * 2 - 1), y = clamp((e.clientY - r.top) / r.height * 2 - 1);
    start = { x: e.clientX, y: e.clientY, tile, touch: e.pointerType === 'touch', moved: false, px: x, py: y };
    clearTimeout(pending);
    if (start.touch) pending = setTimeout(() => { pending = 0; if (start && !start.moved) setPressed(tile, x, y); }, ms('--rk-duration-tap-delay'));
    else setPressed(tile, x, y);
  };
  const move = (e) => {
    if (!start || start.moved) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > (start.touch ? 8 : 4)) {
      start.moved = true; clearTimeout(pending); pending = 0;
      if (pressState.pressed === start.tile) releasePress(true);
    }
  };
  const up = () => {
    if (pending && start && !start.moved) { clearTimeout(pending); pending = 0; setPressed(start.tile, start.px, start.py); }
    releasePress(false);
  };
  const cancel = () => { clearTimeout(pending); pending = 0; if (start) start.moved = true; releasePress(true); };
  const click = (e) => {
    if (e.detail === 0) return;                                           // keyboard and assistive activation
    const control = e.target.closest && e.target.closest(`${TILE}, .rk-rows a, .rk-rows button`);
    if (!control) return;
    const sel = getSelection();
    const selecting = sel && !sel.isCollapsed && control.contains(sel.anchorNode);
    if ((start && start.moved && control.contains(start.tile)) || selecting) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const keydown = (e) => {
    if (e.repeat || turn.running || !e.target.matches || !e.target.matches(TILE)) return;
    if (e.key === 'Enter' || (e.key === ' ' && (e.target.tagName === 'BUTTON' || e.target.matches('[data-rk-press]')))) setPressed(e.target, 0, 0);
  };
  const keyup = (e) => { if (e.key === ' ' || e.key === 'Enter') releasePress(false); };
  const blur = () => releasePress(true);
  const dragstart = (e) => { if (e.target.closest && e.target.closest(TILE)) e.preventDefault(); };
  scope.addEventListener('pointerdown', down);
  scope.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  scope.addEventListener('click', click, true);
  scope.addEventListener('keydown', keydown);
  document.addEventListener('keyup', keyup);
  scope.addEventListener('dragstart', dragstart);
  window.addEventListener('blur', blur);
  return {
    destroy() {
      scope.removeEventListener('pointerdown', down); scope.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
      scope.removeEventListener('click', click, true); scope.removeEventListener('keydown', keydown);
      document.removeEventListener('keyup', keyup); scope.removeEventListener('dragstart', dragstart);
      window.removeEventListener('blur', blur);
    },
  };
}

// Turn ---------------------------------------------------------------------------------------------------------------
// The place change as two primitives. leave(place) turns the visible units of a place away, light ones first, the
// pressed tile last from its pressed pose, then hides the place. enter(place) shows it and turns its units in, light
// ones first. A router (this one, or any other) calls leave, swaps what it renders, then calls enter. finish() ends a
// running turn in its end state: a navigation is never refused.
// The units are the parts a place shows: a plain layout box lets its children turn one by one. Each turns in a time
// that follows its size (heft): a small part turns quicker than a large one, as something light starts and stops
// sooner than something heavy.
let turning = null;
const TURN_PROPS = ['--_rk-turn-origin', '--_rk-turn-oy', '--_rk-turn-delay', '--_rk-turn-duration', '--_rk-turn-perspective', '--_rk-turn-snap', '--_rk-tint'];
const TURN_WHOLE = '.rk-pivot, a, button, input, select, textarea, label, li, tr, p, h1, h2, h3, h4, h5, h6, table, figure, img, svg, canvas, video, pre, blockquote, hr, [role]:not([role=list], [role=group], [role=region], [role=tabpanel], [role=presentation], [role=none])';
const clear = (c) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
// a fill, a border or a shadow of its own
const paints = (el) => {
  const s = getComputedStyle(el);
  return !clear(s.backgroundColor) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' || ['Top', 'Right', 'Bottom', 'Left'].some((e) => parseFloat(s[`border${e}Width`]));
};
// A part turns as one when it is a tile, a strip, a control, a line of text or anything that shows something of its
// own (a fill, a border, a shadow); a plain layout box does not, nor a scroller: its parts turn from its edge.
function turnsWhole(el) {
  if (el.classList.contains('rk-tile') || !el.children.length || el.matches(TURN_WHOLE)) return true;
  const s = getComputedStyle(el);
  if (!/^(block|flex|grid|flow-root)$/.test(s.display)) return true;
  if (paints(el)) return true;
  for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
  return false;
}
// A part's time against the token's grows with its area, against a tile's (heft-reference², 150 × 150):
// heft-tile × (area / tile)^heft-exponent, held between heft-min and heft-max: a line of text about 0.6, a tile 0.8,
// a wide tile 1.0, a table 1.4.
function heftOf() {
  const tile = num('--rk-heft-tile'), side = num('--rk-heft-reference'), exp = num('--rk-heft-exponent'), lo = num('--rk-heft-min'), hi = num('--rk-heft-max');
  return (r) => Math.min(hi, Math.max(lo, tile * Math.pow(Math.max(1, r.width * r.height) / (side * side), exp)));
}
// Heft sets when a part starts as well as how long it takes: light parts first, heavy ones later, (heft - heft-min) ×
// heft-spread × duration-stagger after the turn begins. Parts of one size (heft within 0.05) follow one another in
// reading order, half a duration-stagger apart, six steps at most: the size leads, the order only sorts what weighs
// the same. `pace` is 1, or 0.5 for a place that is called up (calledUp()): half the stagger as well as half the time.
function turnStarts(list, at, held, pace = 1) {
  const step = ms('--rk-duration-stagger') * pace, seen = new Map(), heft = heftOf(), lo = num('--rk-heft-min'), spread = num('--rk-heft-spread');
  return list.map((el) => {
    const h = heft(at.get(el));
    if (el === held) return { h, at: 0 };
    const key = Math.round(h * 20), n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return { h, at: (h - lo) * spread * step + Math.min(n, 6) * step / 2 };
  });
}
function turnUnits(place, last) {
  const list = [], vh = innerHeight, vw = innerWidth;
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  (function walk(el) {
    for (const c of el.children) {
      if (c.hidden || !shown(c)) continue;
      if (turnsWhole(c)) list.push(c); else walk(c);
    }
  })(place);
  const at = new Map(list.map((u) => [u, u.getBoundingClientRect()])), row = num('--rk-turnstile-row') || 8;
  list.sort((a, b) => { const p = at.get(a), q = at.get(b); return (Math.round(p.top / row) - Math.round(q.top / row)) || (p.left - q.left); });
  if (last && at.has(last)) { list.splice(list.indexOf(last), 1); list.push(last); }
  return { list, at };
}
// Each unit turns around the leading edge of the box that clips it, so that edge never cuts it; a unit flush with that
// box's top (within turnstile-flush) turns from its top. A row (top edges rounded to turnstile-row) shares a
// perspective; the pressed tile has the last slot to itself.
// A turning part is a layer, and the compositor rasterises a turned layer from its own top left, rounding within it;
// the page at rest rounds where things lie on the screen. The two agree only when the layer starts on a whole pixel.
// A part with a fill or a line of its own is moved onto the pixels its edges will rest on (--_rk-turn-snap). A part
// that shows only text keeps its text exactly where it is and grows its box up and left to the pixel instead: a
// negative margin and as much padding, so nothing it holds moves, and its glyphs come out the same either way.
function alignLayer(el, r) {
  const dpr = devicePixelRatio || 1, snap = (v) => (Math.round(v * dpr) / dpr - v).toFixed(3);
  const s = getComputedStyle(el);
  if (paints(el) || s.display === 'inline') { el.style.setProperty('--_rk-turn-snap', `${snap(r.left)}px, ${snap(r.top)}px`); return [0, 0]; }
  const fx = r.left - Math.floor(r.left * dpr) / dpr, fy = r.top - Math.floor(r.top * dpr) / dpr;
  el._rkGrow = [el.style.marginLeft, el.style.paddingLeft, el.style.marginTop, el.style.paddingTop];
  el.style.marginLeft = `${parseFloat(s.marginLeft) - fx}px`; el.style.paddingLeft = `${parseFloat(s.paddingLeft) + fx}px`;
  el.style.marginTop = `${parseFloat(s.marginTop) - fy}px`; el.style.paddingTop = `${parseFloat(s.paddingTop) + fy}px`;
  return [fx, fy];                                                   // how far its box grew up and left
}
function unalignLayer(el) {
  if (!el._rkGrow) return;
  [el.style.marginLeft, el.style.paddingLeft, el.style.marginTop, el.style.paddingTop] = el._rkGrow;
  el._rkGrow = null;
}
function turnRows(u, place, held) {
  let slot = -1, key;
  const slots = [], far = [], row = num('--rk-turnstile-row') || 8, flush = num('--rk-turnstile-flush');
  u.list.forEach((el, n) => {
    const r = u.at.get(el);
    let c = el.parentElement;
    while (c && c !== place && getComputedStyle(c).overflowX === 'visible') c = c.parentElement;
    const cr = (c || place).getBoundingClientRect(), k = el === held ? 'P' : Math.round(r.top / row);
    if (k !== key) { slot += 1; key = k; far[slot] = 0; }
    slots.push(slot);
    far[slot] = Math.max(far[slot], r.right - cr.left);
    const [gx, gy] = alignLayer(el, r), left = r.left - gx, top = r.top - gy;
    el.style.setProperty('--_rk-turn-origin', `${cr.left - left}px`);
    if (Math.abs(top - cr.top) < flush) el.style.setProperty('--_rk-turn-oy', '0px');
  });
  u.list.forEach((el, i) => el.style.setProperty('--_rk-turn-perspective', perspective(far[slots[i]])));
  return { slots };
}
// A row's perspective grows with its reach from the edge it turns about, so a wide row turns as flat as a narrow one.
function perspective(far) { return Math.round((num('--rk-turnstile-perspective') || 800) + num('--rk-turnstile-reach') * Math.max(0, far)) + 'px'; }
// A place that is called up and left again many times an hour (a launcher, a start surface; data-rk-called) turns at
// half the pace, in and out: every duration and the stagger halve, the curves, angles and hand-over stay (motion.md).
// A change takes that pace when either side is such a place, so the way in and the way out match.
const calledUp = (...list) => list.some((p) => p && p.hasAttribute && p.hasAttribute('data-rk-called'));
// arrive(el): a place (or the root) builds in: tiles rise and sparklines draw while data-rk-arriving is on, for the arrival
// window: the last tile (three duration-greet steps, then its duration-long rise), a sparkline's duration-long after
// it, and a frame to spare. A framework router calls it for a place it opened by client navigation.
export function arrive(el) {
  el.setAttribute('data-rk-arriving', '');
  const wait = 3 * ms('--rk-duration-greet') + 2 * ms('--rk-duration-long') + 50;
  clearTimeout(el._rkArrive);
  el._rkArrive = setTimeout(() => el.removeAttribute('data-rk-arriving'), wait);
}
// The title a part carries into the place it opens (motion.md): it does not turn away with its part. Leaving, a copy
// stands where it was (the title itself turns transparent, keeping its room, and can still take focus) while the rest
// of the place turns away. Arriving, it travels over duration-moderate on ease-pivot-glide to where the new place
// rests its title: a copy of that title
// travels from the old one's place and size to its own, under the old copy, which fades over the first half, so the
// same words never change and other words cross over. The new place's parts arrive from the middle of the travel on.
// The copies stand in the body, fixed (a place is a container, which would hold a fixed box), with the look
// they had where they stood. Back runs it the other way.
let lifted = null;
const COPIED = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'white-space', 'overflow-wrap', 'color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
function copyOf(el, r) {
  const s = getComputedStyle(el), c = el.cloneNode(true);
  for (const x of [c, ...c.querySelectorAll('[id]')]) x.removeAttribute('id');
  c.removeAttribute('data-rk-carry'); c.removeAttribute('class'); c.setAttribute('aria-hidden', 'true');
  // An inline title keeps its one line: a block as wide as its box would round it onto two.
  const w = s.display === 'inline' ? Math.ceil(r.width) + 1 : r.width;
  c.style.cssText = `${COPIED.map((k) => `${k}:${s.getPropertyValue(k)}`).join(';')};position:fixed;left:${r.left}px;top:${r.top}px;width:${w}px;height:${r.height}px;margin:0;border:0;box-sizing:border-box;display:block;overflow:visible;visibility:visible;pointer-events:none;transform-origin:0 0;z-index:var(--rk-layer-sticky)`;
  return c;
}
function liftTitle(el) {
  const r = el.getBoundingClientRect(), copy = copyOf(el, r);
  document.body.appendChild(copy);
  lifted = { el, copy, r, size: parseFloat(getComputedStyle(el).fontSize) || 1, was: el.style.opacity };
  el.style.opacity = '0';
}
function dropTitle() {
  if (!lifted) return;
  lifted.copy.remove(); lifted.el.style.opacity = lifted.was;
  lifted = null;
}
function flyTitle(to, d) {
  const from = lifted, r = to.getBoundingClientRect(), copy = copyOf(to, r), was = to.style.opacity;
  lifted = null;
  from.copy.before(copy);
  to.style.opacity = '0';
  const k = from.size / (parseFloat(getComputedStyle(to).fontSize) || from.size), dx = from.r.left - r.left, dy = from.r.top - r.top, ease = css('--rk-ease-pivot-glide');
  const anims = [
    copy.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: d, easing: ease, fill: 'forwards' }),
    from.copy.animate([{ transform: 'none' }, { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / k})` }], { duration: d, easing: ease, fill: 'forwards' }),
    from.copy.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], { duration: d, fill: 'forwards' }),
  ];
  let over = false;
  const f = {
    d, host: null, flown: false, held: false,
    // The title shows itself when it has arrived and the part that holds it has come to rest, in the same frame.
    end() {
      if (over) return;
      over = true;
      anims.forEach((a) => a.cancel()); copy.remove(); from.copy.remove();
      from.el.style.opacity = from.was; to.style.opacity = was;
    },
    landed() { f.held = false; if (f.flown) f.end(); },
  };
  f.finished = finished(anims).then(() => { f.flown = true; if (!f.held) f.end(); });
  return f;
}
export const turn = {
  get running() { return !!turning; },
  finish() { if (turning) turning.finish(); },
  leave(place, { pressed = null, back = false, called = calledUp(place), carry = null } = {}) {
    turn.finish();
    dropTitle();
    // A place still building in leaves from its end state: the turn wins over the arrival.
    for (const el of [place, docEl()]) { clearTimeout(el._rkArrive); el.removeAttribute('data-rk-arriving'); }
    return new Promise((resolve) => {
      const timers = [];
      // The pressed tile keeps its press until it leaves; one activated without a press sinks now, in its centre.
      const held = back ? null : pressed;
      let hold = 0;
      if (held) {
        const sinking = held === pressState.pressed || held === pressState.lettingGo;
        if (held !== pressState.last) { held.style.setProperty('--_rk-px', 0); held.style.setProperty('--_rk-py', 0); }
        hold = Math.max(0, ms('--rk-duration-press') - (sinking ? performance.now() - pressState.since : 0));
        if (pressState.pressed === held) pressState.pressed = null;
      }
      releasePress(true);
      if (held) held.setAttribute('data-rk-pressed', '');
      const pace = called ? 0.5 : 1, out = ms('--rk-duration-short') * pace, overlap = num('--rk-turn-overlap');
      const u = turnUnits(place, held), kind = back ? 'back-out' : 'out';
      // A title carried into the next place stands: it is lifted when the part that holds it starts to turn, at once
      // when it is a part of its own.
      const title = carry && ms('--rk-duration-moderate') && carry.getClientRects().length ? carry : null;
      if (title && u.list.includes(title)) { u.list.splice(u.list.indexOf(title), 1); liftTitle(title); }
      const titleHost = title && !lifted ? u.list.find((el) => el.contains(title)) : null;
      turnRows(u, place, held);
      // the pressed tile goes when the last of the others does, or later
      const starts = turnStarts(u.list, u.at, held, pace), lastStart = Math.max(0, ...starts.filter((x, i) => u.list[i] !== held).map((x) => x.at));
      let end = 0;
      u.list.forEach((el, i) => {
        const h = starts[i].h, d = out * h;
        let at = el === held ? lastStart : starts[i].at;
        el.style.setProperty('--_rk-turn-duration', `${Math.round(d)}ms`);
        if (el === titleHost) timers.push(later(() => liftTitle(title), el === held ? Math.max(at, hold) : at));
        if (el === held) {
          at = Math.max(at, hold);
          timers.push(later(() => { if (el.matches(':hover')) el.style.setProperty('--_rk-tint', 'var(--rk-hover)'); el.setAttribute('data-rk-turn', 'pressed'); }, at));
        } else {
          el.style.setProperty('--_rk-turn-delay', `${at}ms`);
          el.setAttribute('data-rk-turn', kind);
        }
        end = Math.max(end, at + overlap * d);
      });
      const done = () => {
        timers.forEach(clearTimeout);
        place.hidden = true;
        if (held) held.removeAttribute('data-rk-pressed');
        for (const el of u.list) { el.removeAttribute('data-rk-turn'); TURN_PROPS.forEach((p) => el.style.removeProperty(p)); unalignLayer(el); }
        turning = null;
        resolve();
      };
      turning = { finish: done };
      // The place goes when its last unit is turn-overlap (75%) through, fading, so the next one swings in without a gap.
      timers.push(later(done, u.list.length ? end : 0));
    });
  },
  enter(place, { back = false, focus = null, arriving = !back, called = calledUp(place), carry = null } = {}) {
    turn.finish();
    return new Promise((resolve) => {
      place.hidden = false;
      // A place you return to comes back as you left it: no second build-in, no redraw.
      if (arriving) arrive(place);
      else place.getAnimations({ subtree: true }).forEach((a) => { if (['rk-build-in', 'rk-build-in-fade', 'rk-draw', 'rk-wipe'].includes(a.animationName)) a.finish(); });
      // Its units turn in from the other side, light ones first, each in its own time.
      const pace = called ? 0.5 : 1, d0 = ms('--rk-duration-moderate') * pace;
      const u = turnUnits(place, null), kind = back ? 'back-in' : 'in';
      // The carried title travels in; the part that holds it lands with it, the others arrive from its middle on.
      const flight = lifted && carry && d0 && carry.getClientRects().length ? flyTitle(carry, d0) : null;
      if (!flight) dropTitle();
      else if (u.list.includes(carry)) u.list.splice(u.list.indexOf(carry), 1);
      else if ((flight.host = u.list.find((el) => el.contains(carry)) || null)) flight.held = true;
      turnRows(u, place, null);
      let end = flight ? d0 : 0;
      const starts = turnStarts(u.list, u.at, null, pace);
      u.list.forEach((el, i) => {
        const { h } = starts[i], d = d0 * h;
        const at = !flight ? starts[i].at : el === flight.host ? Math.max(0, flight.d - d) : starts[i].at + flight.d / 2;
        el.style.setProperty('--_rk-turn-delay', `${at}ms`);
        el.style.setProperty('--_rk-turn-duration', `${Math.round(d)}ms`);
        el.setAttribute('data-rk-turn', kind);
        end = Math.max(end, at + d);
      });
      // Its parts turned in: that is the build-in, so its tiles do not rise again when the turn lets go of them.
      if (arriving && u.list.length) place.setAttribute('data-rk-arriving', 'turned');
      if (focus) focus.focus({ preventScroll: true });
      // Each part is let go when its own motion has really ended, not when a timer or the heaviest part thinks so:
      // one let go a frame early would jump, one held after it stopped would keep its layer and sharpen a moment
      // later. The parts fill backwards only, so motion, animation and layer all end in the same frame.
      let over = false;
      const release = (el) => { el.removeAttribute('data-rk-turn'); TURN_PROPS.forEach((p) => el.style.removeProperty(p)); unalignLayer(el); if (flight && el === flight.host) flight.landed(); };
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        u.list.forEach(release);
        if (flight) flight.end();
        turning = null;
        resolve();
      };
      turning = { finish: done };
      Promise.all([...u.list.map((el) => {
        const own = el.getAnimations().filter((a) => /^rk-turn-(back-)?in$/.test(a.animationName));
        return Promise.all(own.map((a) => a.finished)).then(() => { if (!over) release(el); }, () => {});
      }), flight && flight.finished]).then(done);
      const timer = later(done, end + 250);                      // a part that never animates (hidden meanwhile)
    });
  },
};

// Places -------------------------------------------------------------------------------------------------------------
// A small router for places mounted in the page as <main class="rk-place" data-rk-place="name" data-rk-parent="…">.
// Every place has an address (#name in hash mode, base/name in path mode). Only a place change pushes a history
// entry: facets and section jumps replace nothing and push nothing. Back (the app bar's back, Escape, the browser's
// or the system's back) is history.back() and plays the back turnstile. A crumb links up to the parent place: it is
// back when the parent is the place below, otherwise a step forward to the parent. A cold entry (a deep link, a
// reload) puts the parent place underneath, so back stays in the app. Plain primary clicks on links to places turn
// the place; Ctrl/Cmd/Shift/Alt and middle clicks are the browser's. A navigation is never refused: one that comes
// while a turn runs finishes that turn first.
// A place can show one item at a time (the run a split shows): #name/item. onItem(place, fn, { push }) hears it.
// Choosing an item replaces the address, unless push() says it should be a step of its own (a split in the compact
// class, where the item replaces the list); then back returns to the list. Search and filters are parameters of the
// address (#name?status=failed): setParams() replaces them, never pushing; the watcher hears them on arrival and back.
export function places({ root = document, mode = 'hash', base = '', home, title = document.title, onChange } = {}) {
  const all = () => [...root.querySelectorAll('[data-rk-place]')];
  const byName = (name) => (name ? root.querySelector(`[data-rk-place="${CSS.escape(name)}"]`) : null);
  home = home || (all()[0] && all()[0].dataset.rkPlace);
  const enc = encodeURIComponent;
  const urlOf = (name, item = null, params = '') => {
    const q = params ? `?${params}` : '';
    return mode === 'hash'
      ? (name === home && !item && !q ? location.pathname + location.search : `#${enc(name)}${item ? `/${enc(item)}` : ''}${q}`)
      : `${base}/${name === home && !item ? '' : enc(name)}${item ? `/${enc(item)}` : ''}${q}`;
  };
  // An address's place and item, or null when it names no place here.
  const parse = (href) => {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    if (mode === 'hash' && (u.pathname !== location.pathname || u.search !== location.search)) return null;
    if (mode === 'path' && !(u.pathname === base || u.pathname.startsWith(`${base}/`))) return null;
    let raw = mode === 'hash' ? u.hash.slice(1) : u.pathname.slice(base.length).replace(/^\/|\/$/g, '');
    let params = mode === 'hash' ? '' : u.search.slice(1);
    if (mode === 'hash' && raw.includes('?')) { params = raw.slice(raw.indexOf('?') + 1); raw = raw.slice(0, raw.indexOf('?')); }
    const [first, ...rest] = raw.split('/');
    const name = decodeURIComponent(first || '') || home, item = rest.length ? decodeURIComponent(rest.join('/')) : null;
    return byName(name) ? { name, item, params } : null;
  };
  const nameOf = (href) => { const p = parse(href); return p && p.name; };
  const parentOf = (name) => { const p = byName(name) && byName(name).dataset.rkParent; return byName(p) ? p : home; };
  const titleOf = (name) => { const h = byName(name).querySelector('.rk-title'); const t = h && h.textContent.trim(); return name === home || !t ? title : `${t} · ${title}`; };
  // Everything that scrolls in a place keeps its offset while the place is away.
  let current = home, item = null, params = '', index = 0, below = null, pushedItem = false, busy = Promise.resolve();
  const watchers = new Map();
  const backButtons = () => document.querySelectorAll('.rk-ab-back[data-rk-back], .rk-titlebar [data-rk-back]');
  // Links to places, in the app bar (.rk-ab-places) or a place strip of links (.rk-pivot--nav): the one you are in is
  // marked; on a place below it, the one you came from stays marked.
  const placeLinks = (box) => [...box.querySelectorAll(':scope > a[href]')].filter((a) => nameOf(a.href));
  const showBack = () => {
    backButtons().forEach((b) => { b.hidden = current === home && index === 0; });
    for (const box of document.querySelectorAll('.rk-ab-places, .rk-pivot--nav')) {
      const links = placeLinks(box), here = links.find((a) => nameOf(a.href) === current);
      if (here) links.forEach((a) => { if (a === here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    }
  };
  navTurn = turn;                                         /* a pivot that picks the place turns it */
  const strips = [...document.querySelectorAll('.rk-pivot--nav:not([role=tablist])')].filter((n) => placeLinks(n).length).map((n) => strip(n));
  const rk = () => (history.state && history.state.rk) || {};
  function snapshot(opener) {
    const el = byName(current), prev = rk();
    return { ...(history.state || {}), rk: { ...prev, place: current, index, below, item, params, pushedItem, scrollY, scroll: scrollState(el).capture(), opener: opener || prev.opener || null } };
  }
  function restore(el, state) {
    scrollState(el).restore(state && state.scroll && !Array.isArray(state.scroll) ? state.scroll : { y: 0, at: {} });
    scrollTo({ left: 0, top: (state && state.scrollY) || 0, behavior: 'instant' });
  }
  function focusTarget(to, state, back) {
    if (back && state && state.opener) {
      const o = [...to.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === state.opener);
      if (o && o.getClientRects().length) return o;
    }
    const t = to.querySelector('.rk-title') || to;
    if (!t.hasAttribute('tabindex') && !t.matches('a, button, input, select, textarea')) t.setAttribute('tabindex', '-1');
    return t;
  }
  // The place's item or parameters changed: tell its watcher, which may name the item for the title.
  function setItem(next, opts = {}) {
    item = next || null;
    const w = watchers.get(current), named = w ? w.fn(item, { ...opts, params: new URLSearchParams(params) }) : null;
    document.title = typeof named === 'string' && named ? `${named} · ${titleOf(current)}` : titleOf(current);
  }
  // The title that travels (motion.md): forward, the opened part's [data-rk-carry] to the new place's title; back, the
  // place's title to the [data-rk-carry] of the part that opened it.
  const carried = (el) => (el ? (el.matches('[data-rk-carry]') ? el : el.querySelector('[data-rk-carry]')) : null);
  function carryOf(from, to, state, back, pressed) {
    const opener = back && state && state.opener ? [...to.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === state.opener) : null;
    const pair = back ? [from.querySelector('.rk-title'), carried(opener)] : [carried(pressed), to.querySelector('.rk-title')];
    return pair[0] && pair[1] ? pair : [null, null];
  }
  function show(name, state, { instant = false, back = false, pressed = null } = {}) {
    const prev = current, from = byName(prev), to = byName(name);
    current = name;
    below = state ? state.below || null : null;
    pushedItem = !!(state && state.pushedItem);
    params = (state && state.params) || '';
    showBack();
    const run = async () => {
      const [lifts, lands] = from && from !== to && !instant ? carryOf(from, to, state, back, pressed) : [null, null];
      if (from && from !== to) {
        if (instant) { turn.finish(); from.hidden = true; } else await turn.leave(from, { back, pressed, called: calledUp(from, to), carry: lifts });
      }
      to.hidden = false;
      setItem(state && state.item, { back, place: true });
      restore(to, state);
      const f = focusTarget(to, state, back);
      if (instant) { turn.finish(); if (!back) arrive(to); f.focus({ preventScroll: true }); } else await turn.enter(to, { back, focus: f, called: calledUp(from, to), carry: lands });
      if (onChange) onChange({ from: prev, to: name, back });
      document.dispatchEvent(new CustomEvent('rk:placechange', { detail: { from: prev, to: name, back } }));
    };
    busy = busy.then(run, run);
    return busy;
  }
  // Guards (unsaved input) may hold a place change: each returns true at once when it has nothing to ask, or false,
  // or a promise of the answer. verdict() is true when every guard lets go at once, else a promise.
  const guards = new Set();
  let bypass = false, ignoreNext = null;
  function verdict() {
    const answers = [...guards].map((g) => { try { return g(); } catch { return false; } });
    if (answers.every((a) => a === true)) return true;
    return Promise.all(answers.map((a) => Promise.resolve(a).catch(() => false))).then((all) => all.every(Boolean));
  }
  function navigate(target, { replace = false, pressed = null, force = false } = {}) {
    const p = byName(target) ? { name: target, item: null } : parse(target);
    if (!p) return Promise.resolve();
    if (p.name === current) { if (p.item !== item) open(p.item); return Promise.resolve(); }
    if (!force) { const v = verdict(); if (v !== true) return Promise.resolve(v).then((ok) => (ok ? navigate(target, { replace, pressed, force: true }) : undefined)); }
    turn.finish();
    history.replaceState(snapshot(pressed && pressed.getAttribute('href')), '');
    const entry = { rk: { place: p.name, index: replace ? index : index + 1, below: replace ? below : current, item: p.item, params: p.params || '', pushedItem: false } };
    if (replace) history.replaceState(entry, '', urlOf(p.name, p.item, entry.rk.params)); else history.pushState(entry, '', urlOf(p.name, p.item, entry.rk.params));
    index = entry.rk.index;
    return show(p.name, entry.rk, { pressed });
  }
  // open(item): show an item of the current place (null: none). It replaces the address unless the watcher's push()
  // says it is a step of its own.
  function open(next, { replace } = {}) {
    next = next || null;
    if (next === item) return;
    const w = watchers.get(current);
    const push = replace === undefined ? !!(next && !pushedItem && w && w.push && w.push()) : !replace;
    if (push) {
      history.replaceState(snapshot(), '');
      index += 1; pushedItem = true;
      history.pushState({ rk: { place: current, index, below, item: next, params, pushedItem: true } }, '', urlOf(current, next, params));
    } else {
      const s = snapshot();
      history.replaceState({ ...s, rk: { ...s.rk, item: next } }, '', urlOf(current, next, params));
    }
    setItem(next, { back: false });
  }
  // back(): one step back in history; at the bottom of the app's history, up to the parent place instead.
  // back(name): up to that place, by history when it is the place below (or, for an item, the list beneath it).
  function back(target) {
    if (target && target === current) {
      if (item && pushedItem && index > 0) { turn.finish(); history.back(); } else open(null, { replace: true });
      return true;
    }
    if (target && target !== below) { navigate(target); return true; }
    if (index > 0) {
      turn.finish(); history.replaceState(snapshot(), '');
      if (target && pushedItem && index > 1) history.go(-2); else history.back();
      return true;
    }
    if (current === home) return false;
    const up = target || parentOf(current);
    const go = () => { history.replaceState({ rk: { place: up, index: 0, below: null } }, '', urlOf(up)); show(up, null, { back: true }); };
    const v = verdict();
    if (v === true) go(); else Promise.resolve(v).then((ok) => { if (ok) go(); });
    return true;
  }
  const pop = (e) => {
    if (ignoreNext) { const done = ignoreNext; ignoreNext = null; done(); return; }
    const state = e.state && e.state.rk;
    const p = state && byName(state.place) ? { name: state.place, item: state.item || null, params: state.params || '' } : parse(location.href);
    if (!p) return;
    const to = state ? state.index : 0, backward = to < index, jump = Math.abs(to - index);
    // The browser has already moved; a guard that holds the change takes the step back, asks, and replays it.
    const v = p.name !== current && !bypass && to !== index ? verdict() : true;
    if (v !== true) {
      const delta = to - index;
      const reverted = new Promise((r) => { ignoreNext = r; });
      history.go(-delta);
      Promise.all([v, reverted]).then(([ok]) => { if (ok) { bypass = true; history.go(delta); } });
      return;
    }
    bypass = false;
    turn.finish();
    index = to;
    if (p.name === current) {
      below = state ? state.below || null : null;
      pushedItem = !!(state && state.pushedItem);
      const paramsChanged = (p.params || '') !== params;
      params = p.params || '';
      if (p.item !== item || paramsChanged) setItem(p.item, { back: backward });
      restore(byName(current), state);
      showBack();
      return;
    }
    show(p.name, state || { item: p.item, params: p.params }, { back: backward, instant: jump > 1 || e.hasUAVisualTransition });
  };
  const click = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const backer = e.target.closest && e.target.closest('[data-rk-back]');
    if (backer) {
      e.preventDefault();
      back(backer.matches('a[href]') ? nameOf(backer.href) : undefined);
      return;
    }
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const p = parse(a.href);
    if (!p) return;
    e.preventDefault();
    if (p.name === current) open(p.item);
    else navigate(a.href, { pressed: a.matches('.rk-tile') ? a : null });
  };
  const offKeys = keys.on(10, (e) => {
    if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (current === home && index === 0 && !item) || !keys.escapeIsFree(e)) return false;
    if (index === 0 && item) { open(null, { replace: true }); return true; }
    return back();
  });
  // Start on the place and item the address names. A cold entry puts the parent place underneath, and the place's
  // list beneath an item, so back stays in the app.
  const start = parse(location.href) || { name: home, item: null, params: '' };
  const st = rk();
  if (st.place === start.name && (st.item || null) === start.item) {
    index = st.index || 0; below = st.below || null; pushedItem = !!st.pushedItem;
  } else {
    const chain = [];
    if (start.name !== home) chain.push({ place: parentOf(start.name), item: null, below: null });
    const placeBelow = start.name !== home ? parentOf(start.name) : null;
    if (start.item) chain.push({ place: start.name, item: null, below: placeBelow });
    chain.push({ place: start.name, item: start.item, below: placeBelow, pushedItem: !!start.item, params: start.params });
    chain.forEach((c, i) => {
      const entry = { rk: { place: c.place, index: i, below: c.below, item: c.item, params: c.params || '', pushedItem: !!c.pushedItem } };
      if (i === 0) history.replaceState({ ...(history.state || {}), ...entry }, '', urlOf(c.place, c.item, entry.rk.params));
      else history.pushState(entry, '', urlOf(c.place, c.item, entry.rk.params));
    });
    index = chain.length - 1; below = placeBelow; pushedItem = !!start.item;
  }
  for (const el of all()) el.hidden = el.dataset.rkPlace !== start.name;
  current = start.name;
  item = start.item;
  params = start.params || '';
  document.title = titleOf(current);
  showBack();
  if (st.place === start.name) requestAnimationFrame(() => restore(byName(current), st));
  addEventListener('popstate', pop);
  document.addEventListener('click', click);
  return {
    get current() { return current; },
    get item() { return item; },
    get below() { return below; },
    get params() { return new URLSearchParams(params); },
    // setParams(p): the current place's search and filters, in the address; replaces, never pushes.
    setParams(p) {
      const next = new URLSearchParams(p).toString();
      if (next === params) return;
      params = next;
      const s = snapshot();
      history.replaceState({ ...s, rk: { ...s.rk, params } }, '', urlOf(current, item, params));
    },
    navigate, back, open, urlOf,
    // guard(fn): fn() may hold any change of place, from a link, back, Escape or the browser. It returns true at once
    // when it has nothing to ask (then nothing waits), else false or a promise of the answer. Returns a remover.
    guard(fn) { guards.add(fn); return () => guards.delete(fn); },
    // onItem(place, fn, { push }): fn(item | null, { back, initial }) whenever that place's item changes; it may
    // return a name for the window title. push() decides whether choosing an item is a history step of its own.
    onItem(place, fn, { push } = {}) {
      watchers.set(place, { fn, push });
      if (place === current) setItem(item, { initial: true });
      return () => watchers.delete(place);
    },
    destroy() { removeEventListener('popstate', pop); document.removeEventListener('click', click); offKeys(); strips.forEach((x) => x.destroy()); },
  };
}

// Panorama -----------------------------------------------------------------------------------------------------------
// Sideways (the place is wide and the viewport tall enough) a panorama moves sideways; compact it stacks. One wheel
// gesture (events closer than duration-wheel-latch) latches to one scroller: to a section that can still scroll in
// its direction, and is then swallowed at that section's end instead of turning sideways; otherwise to the panorama,
// and stays sideways while the pointer crosses sections. Horizontal input and Shift+wheel stay native; at either end
// the wheel falls through. Keys on the focused panorama: ← → PageUp PageDown jump a section, Home End to the ends.
// A pivot of section links follows the scroll; choosing a link aligns that section flush left (or as far as the
// panorama scrolls) and moves focus to its heading. When everything fits, nothing scrolls (data-rk-fit).
export function panorama(el, { pivot = null } = {}) {
  const sections = () => [...el.querySelectorAll(':scope > .rk-sec')];
  const sideways = () => getComputedStyle(el).display === 'flex' && getComputedStyle(el).overflowX !== 'visible';
  let current = sections()[0] || null, gesture = null, clicked = false, wasSideways = sideways();
  const glideEase = bezier('--rk-ease-pivot-glide');
  const links = () => (pivot ? [...pivot.querySelectorAll('a[href^="#"]')] : []);
  const linkFor = (sec) => links().find((a) => a.hash === `#${sec.id}`);

  function startOf(sec) {
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    return Math.min(el.scrollLeft + sec.getBoundingClientRect().left - el.getBoundingClientRect().left - pad, el.scrollWidth - el.clientWidth);
  }
  function mark(sec) {
    if (!sec) return;
    current = sec;
    for (const a of links()) { if (a.hash === `#${sec.id}`) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); }
    if (pivot) pivotGlide(pivot, linkFor(sec));
  }
  function goTo(sec, { focus = true, instant = false } = {}) {
    if (typeof sec === 'string') sec = el.querySelector(`#${CSS.escape(sec)}`);
    if (!sec) return;
    clicked = true;
    mark(sec);
    if (sideways()) animateScroll(el, startOf(sec), instant ? 0 : ms('--rk-duration-pivot-glide'), glideEase);
    else sec.scrollIntoView({ behavior: instant || !ms('--rk-duration-short') ? 'instant' : 'smooth', block: 'start' });
    if (focus) focusHeading(sec);
  }
  function follow() {
    if (clicked) return;
    const list = sections();
    if (!list.length) return;
    let active = list[0];
    if (sideways()) {
      const edge = el.getBoundingClientRect().left, reach = el.clientWidth / 3;
      for (const s of list) if (s.getBoundingClientRect().left - edge <= reach) active = s;
      // At either end the end's section is the one, however narrow the sections are (several edges may lie in the
      // first third of the width).
      if (Math.abs(el.scrollLeft) <= 1) active = list[0];
      else if (Math.abs(el.scrollLeft) >= el.scrollWidth - el.clientWidth - 1) active = list[list.length - 1];
    } else {
      const edge = num('--rk-banner-h') + num('--rk-pivot-h'), reach = innerHeight / 3;
      for (const s of list) if (s.getBoundingClientRect().top - edge <= reach) active = s;
    }
    if (active !== current) mark(active);
  }
  let queued = false;
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; follow(); }); } };
  // A scroll of the user's own ends a jump's hold on the mark; a key the panorama took for a jump (key(), which runs
  // first and prevents its default) is the jump itself, so its target stays marked for the whole glide.
  const userScroll = (e) => { if (e.type === 'keydown' && e.defaultPrevented) return; clicked = false; };

  // One gesture, one scroller.
  function wheel(e) {
    if (e.ctrlKey || !sideways()) return;                                            // pinch zoom; compact
    const now = e.timeStamp, latch = ms('--rk-duration-wheel-latch') || 200;
    const horizontal = e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY);
    const down = e.deltaY > 0;
    if (!gesture || now - gesture.last > latch) {
      clicked = false;
      gesture = { target: 'pan', inner: null };
      if (horizontal) gesture.target = 'native';
      else {
        for (let n = e.target; n && n !== el; n = n.parentElement) {
          const can = n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY);
          if (can && (down ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) { gesture = { target: 'inner', inner: n }; break; }
        }
      }
    }
    gesture.last = now;
    if (gesture.target === 'native' || horizontal) return;
    if (gesture.target === 'inner') {
      const n = gesture.inner;
      const room = down ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;
      if (!room) e.preventDefault();                                                  // swallowed at its end
      return;
    }
    const max = el.scrollWidth - el.clientWidth;
    if (down ? el.scrollLeft >= max - 1 : el.scrollLeft <= 0) return;                // falls through at the ends
    e.preventDefault();
    el.scrollBy({ left: e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1), behavior: 'instant' });
  }
  function key(e) {
    if (e.target !== el || !sideways() || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = sections(), i = Math.max(0, list.indexOf(current));
    const to = { ArrowRight: i + 1, PageDown: i + 1, ArrowLeft: i - 1, PageUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    goTo(list[Math.max(0, Math.min(list.length - 1, to))], { focus: false });
  }
  function pivotClick(e) {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const sec = el.querySelector(a.hash);
    if (!sec) return;
    e.preventDefault();
    goTo(sec);
  }
  // A panorama that reaches past its window never ends flush on a section edge, so something always says there is more
  // (layout.md): the window's edge falls inside a section, at least space-xl from either of its ends. The sections keep
  // their size; the gap between them (space-xl) changes by as little as that takes, never below space-m; a last section
  // cut by less than space-xl fits instead, when a smaller gap lets it. The edge is where it lies with the first section
  // at the start, and with any section aligned there, when they are all as wide. Says whether everything fits; then
  // nothing scrolls.
  function spread(list) {
    const xl = num('--rk-space-xl'), least = num('--rk-space-m'), sizes = list.map((s) => parseFloat(getComputedStyle(s).width) || 0);
    const edge = el.clientWidth - (parseFloat(getComputedStyle(el).paddingLeft) || 0), n = sizes.length;
    const before = (j) => sizes.slice(0, j).reduce((a, w) => a + w, 0);
    const fitsWith = (g) => before(n) + (n - 1) * g <= edge + 1;
    const inside = (g) => sizes.some((w, i) => before(i) + i * g + xl <= edge + 0.5 && edge - 0.5 <= before(i) + i * g + w - xl);
    let gap = xl;
    if (sideways() && !fitsWith(xl) && !inside(xl)) {
      const ways = n > 1 ? [Math.floor((edge - before(n)) / (n - 1))] : [];      // everything fits
      for (let j = 1; j <= n; j += 1) {
        if (j < n) ways.push(Math.floor((edge - xl - before(j)) / j));            // section j shows space-xl
        if (j > 1) ways.push(Math.ceil((edge + xl - before(j)) / (j - 1)));      // section j - 1 reaches space-xl past it
      }
      const best = ways.filter((g) => g >= least && (inside(g) || fitsWith(g))).sort((a, b) => Math.abs(a - xl) - Math.abs(b - xl))[0];
      if (best !== undefined) gap = best;
    }
    if (gap === xl) el.style.removeProperty('--_rk-sec-gap'); else el.style.setProperty('--_rk-sec-gap', `${gap}px`);
    return fitsWith(gap);
  }
  function fit() {
    const list = sections();
    // A panorama in a place that is away keeps everything as it was; it is measured again when it shows.
    if (!list.length || !el.getClientRects().length) { stickyStrip(); return; }
    const was = el.style.getPropertyValue('--_rk-sec-gap');
    el.toggleAttribute('data-rk-fit', sideways() && spread(list.filter((s) => s.getClientRects().length)));
    if (pivot) { pivotScale(pivot); pivotFit(pivot); }
    stickyStrip();
    // A change of window-size class keeps the reading position: the current section is state, not an offset. So does
    // a new gap between the sections.
    const now = sideways();
    if (now !== wasSideways || (now && el.scrollLeft > 0 && el.style.getPropertyValue('--_rk-sec-gap') !== was)) {
      wasSideways = now; if (current) goTo(current, { focus: false, instant: true }); clicked = false;
    }
  }
  // A section strip that sticks (compact, a direct child of the place) publishes its height, so focus and section
  // jumps land below it.
  let wrote = false;
  function stickyStrip() {
    if (!pivot) return;
    const sticky = pivot.getClientRects().length && pivot.parentElement.classList.contains('rk-place') && getComputedStyle(pivot).position === 'sticky';
    if (sticky) { docEl().style.setProperty('--rk-pivot-h', `${pivot.offsetHeight}px`); wrote = true; }
    else if (wrote) { docEl().style.removeProperty('--rk-pivot-h'); wrote = false; }
  }
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  if (pivot) ro.observe(pivot);
  const short = matchMedia('(min-height: 481px)');
  short.addEventListener('change', fit);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('keydown', key);
  el.addEventListener('scroll', queue, { passive: true });
  addEventListener('scroll', queue, { passive: true });
  for (const ev of ['wheel', 'touchstart', 'keydown']) el.addEventListener(ev, userScroll, { passive: true });
  if (pivot) { pivot.addEventListener('click', pivotClick); pivot.addEventListener('wheel', stripWheel, { passive: false }); pivotScale(pivot); }
  if (document.fonts) document.fonts.ready.then(fit);
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = 0;
  // Focusable, it is a landmark the keys act on: a region, and a region needs a name to be announced as one.
  if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) console.warn('Rekta.panorama(): give the panorama an aria-label or aria-labelledby; it takes focus, and a region without a name is announced as nothing', el);
  requestAnimationFrame(() => { fit(); mark(current); });
  return {
    goTo,
    get current() { return current; },
    destroy() {
      ro.disconnect(); short.removeEventListener('change', fit);
      el.removeEventListener('wheel', wheel); el.removeEventListener('keydown', key); el.removeEventListener('scroll', queue);
      removeEventListener('scroll', queue);
      if (pivot) { pivot.removeEventListener('click', pivotClick); pivot.removeEventListener('wheel', stripWheel); }
    },
  };
}
// A strip of titles moves sideways under a vertical wheel, inside its own box only.
function stripWheel(e) {
  const strip = e.currentTarget;
  if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  const max = strip.scrollWidth - strip.clientWidth, down = e.deltaY > 0;
  if (max <= 0 || (down ? strip.scrollLeft >= max - 1 : strip.scrollLeft <= 0)) return;
  e.preventDefault();
  strip.scrollBy({ left: e.deltaY * (e.deltaMode === 1 ? 16 : 1), behavior: 'instant' });
}

// Pivot --------------------------------------------------------------------------------------------------------------
// Inactive titles scale down from the active title's line box by the token ratio (pivot-inactive / pivot-active, or
// nav-inactive / nav-active for rk-pivot--nav; the stylesheet names the inactive size in --_rk-inactive), measured in
// the page so fluid sizes and window-size classes stay right. They scale about the baseline, so every title stands on
// the active one's: the distance from the baseline to the line box's bottom (the face's descent and half the leading)
// is measured too, in --_rk-base, the transform's origin.
function pivotScale(strip) {
  if (!strip.getClientRects().length) return;
  // Measuring is not a change to show: from the stylesheet's measure-free sizes (font-size) to the scale the first time,
  // and a new width after a resize or a font load, apply at once.
  const titles = [...strip.querySelectorAll(':scope > a, :scope > button')];
  for (const el of titles) el.style.transition = 'none';
  strip.setAttribute('data-rk-measured', '');
  const probe = document.createElement('span');
  probe.dataset.rkProbe = '';
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--_rk-inactive)';
  strip.appendChild(probe);
  const item = strip.querySelector('a, button');
  const inactive = parseFloat(getComputedStyle(probe).fontSize), active = item ? parseFloat(getComputedStyle(item).fontSize) : inactive;
  probe.remove();
  if (inactive && active) strip.style.setProperty('--rk-pivot-scale', (inactive / active).toFixed(3));
  if (item) {
    // A line in the title's font with an empty inline block on its baseline: the block's foot is the baseline.
    const line = document.createElement('span'), mark = document.createElement('span');
    line.dataset.rkProbe = '';
    line.style.cssText = 'position:absolute;visibility:hidden;display:block;white-space:nowrap';
    line.style.font = getComputedStyle(item).font;
    line.textContent = 'x';
    mark.style.cssText = 'display:inline-block;width:0;height:0';
    line.appendChild(mark);
    strip.appendChild(line);
    const base = line.getBoundingClientRect().bottom - mark.getBoundingClientRect().bottom;
    line.remove();
    if (base >= 0) strip.style.setProperty('--_rk-base', `${base.toFixed(2)}px`);
  }
  for (const el of titles) if (el.offsetWidth) el.style.setProperty('--_rk-w', `${el.offsetWidth}px`);
  void strip.offsetWidth;
  for (const el of titles) el.style.transition = '';
}
function pivotFit(strip) {
  const items = [...strip.querySelectorAll(':scope > a, :scope > button')];
  if (!items.length) return;
  const last = items[items.length - 1];
  const right = strip.scrollLeft + last.getBoundingClientRect().right - strip.getBoundingClientRect().left;
  strip.toggleAttribute('data-rk-fit', right <= strip.clientWidth + 1);
}
// A strip that does not fit glides by the active title's place in the order, not to it: the first title at the start,
// the last at the end, those between in proportion, so the titles before the active one stay in reach. The active
// title is always whole on screen, and the one before it too where both fit. One that fits holds still. The titles are
// still changing size while it glides, so the target is where they end up, not where they are now.
function pivotGlide(strip, item) {
  if (!item || strip.hasAttribute('data-rk-fit') || getComputedStyle(strip).flexDirection === 'column') return;
  const titles = [...strip.querySelectorAll(':scope > a, :scope > button')], i = titles.indexOf(item);
  if (i < 0) return;
  const style = getComputedStyle(strip), s = parseFloat(style.getPropertyValue('--rk-pivot-scale')) || 0.6;
  const gap = parseFloat(style.columnGap) || 0, padL = parseFloat(style.paddingLeft) || 0, padR = parseFloat(style.paddingRight) || 0;
  let x = 0, left = 0, width = 0, prev = 0;
  for (const t of titles) {
    const w = t === item ? t.offsetWidth : t.offsetWidth * s;
    if (t === item) { left = x; width = w; }
    if (t === titles[i - 1]) prev = x;
    x += w + gap;
  }
  const room = strip.clientWidth - padL - padR, max = Math.max(0, x - gap - room);
  const by = max * (titles.length > 1 ? i / (titles.length - 1) : 0);
  const to = Math.min(max, Math.max(0, left + width - room, Math.min(by, i ? prev : left)));
  animateScroll(strip, to, ms('--rk-duration-pivot-glide'), bezier('--rk-ease-pivot-glide'));
}
// A pivot that picks the place (rk-pivot--nav) turns it: the panel in sight turns away, then the next turns in, the
// way back when its title is earlier in the order. Any other pivot picks a facet: the panel slides in from its side.
// Down the side (rk-pivot--side) Up and Down pick a title; along the top Left and Right.
// The place turn a pivot that picks the place (rk-pivot--nav) uses: places() registers it, or pivot(el, { turn }) takes
// it. A facet pivot never references the turn, so a bundle that only uses facets leaves it out.
let navTurn = null;
export function pivot(el, { onSelect, turn: placeTurn = null, gone = 'select' } = {}) {
  const tabs = () => [...el.querySelectorAll('[role=tab]')];
  const panel = (t) => document.getElementById(t.getAttribute('aria-controls'));
  const nav = el.classList.contains('rk-pivot--nav');
  let gen = 0, wide = false, host = null, following = 0;
  const chosen = () => tabs().findIndex((t) => t.getAttribute('aria-selected') === 'true');
  // Wide: from size.pivot-wide up (the width of the panels' common parent), every facet shows, side by side as
  // panorama sections; the strip is a jump list that follows the scroll. A pivot that picks the place never goes wide.
  const panels = () => tabs().map(panel);
  const startOf = (p) => Math.min(host.scrollLeft + p.getBoundingClientRect().left - host.getBoundingClientRect().left - (parseFloat(getComputedStyle(host).paddingLeft) || 0), host.scrollWidth - host.clientWidth);
  let last = 0;                                          // the facet chosen last, to find its neighbour when it goes
  function mark(i) {
    last = i;
    const list = tabs();
    list.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
    pivotGlide(el, list[i]);
  }
  // Who owns hidden on the panels: pivot() sets it one facet at a time (from the start, too); wide, it leaves hidden as
  // it is and shows every panel with data-rk-reveal, so a framework that binds hidden to the chosen facet stays right.
  function narrow() { const i = Math.max(0, chosen()); panels().forEach((p, k) => { if (p) { p.removeAttribute('data-rk-reveal'); p.hidden = k !== i; } }); }
  // The width that decides: the panels' common parent's, or with .rk-facets around it, that container's content
  // width, the one rekta.css's first paint queries, so the two never disagree.
  const widthOf = (parent) => {
    const box = parent.parentElement && parent.parentElement.classList.contains('rk-facets') ? parent.parentElement : null;
    if (!box) return parent.clientWidth;
    const s = getComputedStyle(box);
    return box.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
  };
  function layout() {
    const ps = panels(), parent = ps.length && ps.every((p) => p && p.parentElement === ps[0].parentElement) ? ps[0].parentElement : null;
    const min = px('--rk-pivot-wide', el), now = !nav && !!parent && min > 0 && widthOf(parent) >= min;
    if (parent && !nav) parent.toggleAttribute('data-rk-narrow', !now);    /* decided: the first paint's rules step back */
    if (now === wide) return;
    wide = now; host = now ? parent : null;
    el.toggleAttribute('data-rk-wide', now);
    if (parent) parent.toggleAttribute('data-rk-wide', now);
    const i = Math.max(0, chosen());
    if (now) ps.forEach((p) => { if (p) p.setAttribute('data-rk-reveal', ''); }); else narrow();
    if (now && ps[i]) host.scrollLeft = startOf(ps[i]);
  }
  function follow() {                                    /* wide: the facet at the leading edge is the one chosen */
    if (!wide || Date.now() < following) return;
    const box = host.getBoundingClientRect(), edge = box.left + (parseFloat(getComputedStyle(host).paddingLeft) || 0) + 1;
    const ps = panels(), mine = ps[chosen()];
    if (mine) { const r = mine.getBoundingClientRect(); if (r.left >= box.left - 1 && r.right <= box.right + 1) return; }   /* still whole in sight: it stays */
    let i = ps.findIndex((p) => p && p.getBoundingClientRect().right > edge + p.getBoundingClientRect().width / 2);
    if (host.scrollLeft + host.clientWidth >= host.scrollWidth - 1) i = ps.length - 1;   /* at the end: the last */
    if (i >= 0 && i !== chosen()) { mark(i); if (onSelect) onSelect(i, tabs()[i]); }
  }
  // A facet by its index, or by name: the tab's id, its data-facet or its panel's id (an app that holds the facet by
  // name need not map it to an index that shifts when a facet comes or goes).
  const indexOf = (key) => (typeof key === 'number' ? key : tabs().findIndex((t) => t.id === key || t.dataset.facet === key || t.getAttribute('aria-controls') === key));
  // select(i, { focus, silent }): silent, as when the app sets the facet from its own state, calls no onSelect.
  function select(key, { focus = false, silent = false } = {}) {
    const i = indexOf(key), list = tabs(), prev = chosen(), told = (k) => { if (!silent && onSelect) onSelect(k, list[k]); };
    if (!list[i]) return;
    last = i;
    if (wide) {
      const p = panel(list[i]), d = ms('--rk-duration-pivot-glide');
      following = Date.now() + d + 50;                  /* the glide is not a scroll to follow */
      mark(i);
      if (p) animateScroll(host, startOf(p), d, bezier('--rk-ease-pivot-glide'));
      if (focus) list[i].focus();
      if (i !== prev) told(i);
      return;
    }
    if (i === prev) return;
    const turn = placeTurn || navTurn;
    if (nav && turn) {
      turn.finish();
      const from = list.map(panel).find((p) => p && !p.hidden), to = panel(list[i]), back = i < prev, mine = ++gen;
      list.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; const p = panel(t); if (p && p !== from) p.hidden = true; });
      pivotGlide(el, list[i]);
      if (focus) list[i].focus();
      (from ? turn.leave(from, { back, called: calledUp(from, to) }) : Promise.resolve()).then(() => { if (mine === gen && to) turn.enter(to, { back, called: calledUp(from, to) }); });
      told(i);
      return;
    }
    list.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; const p = panel(t); if (p) p.hidden = k !== i; });
    pivotGlide(el, list[i]);
    const d = ms('--rk-duration-moderate') * 0.75, p = panel(list[i]);
    if (d && p) p.animate([{ transform: `translateX(${(i > prev ? 1 : -1) * num('--rk-slide-distance')}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: d, easing: css('--rk-ease-out') });
    if (focus) list[i].focus();
    told(i);
  }
  // Facets that come and go (an open question, errors, a draft): one tab stays the tab stop and chosen, and every
  // panel is hidden or revealed as the mode says. When the chosen facet has gone, its neighbour is chosen (the one now
  // in its place, else the last), with onSelect unless gone: 'silent'.
  function sync({ quiet = false } = {}) {
    const list = tabs();
    if (!list.length) return;
    let i = chosen();
    if (i < 0) {
      i = Math.min(last, list.length - 1);
      mark(i);
      if (!quiet && gone !== 'silent' && onSelect) onSelect(i, list[i]);
    } else {
      last = i;
      list.forEach((t, k) => { if (k !== i) t.setAttribute('aria-selected', 'false'); t.tabIndex = k === i ? 0 : -1; });
    }
    if (wide) panels().forEach((p) => { if (p) p.setAttribute('data-rk-reveal', ''); }); else narrow();
  }
  const click = (e) => { const t = e.target.closest('[role=tab]'); if (t) select(tabs().indexOf(t)); };
  const key = (e) => {
    const list = tabs(), i = list.indexOf(e.target);
    if (i < 0) return;
    if (wide && e.key === 'Tab' && !e.shiftKey) {        /* wide: from the strip into the facet chosen, not the first */
      const p = panel(list[i]);
      if (p) { e.preventDefault(); if (!p.hasAttribute('tabindex')) { p.tabIndex = -1; p._rkTab = true; } p.focus({ preventScroll: true }); }
      return;
    }
    const down = getComputedStyle(el).flexDirection === 'column';
    const to = { [down ? 'ArrowDown' : 'ArrowRight']: i + 1, [down ? 'ArrowUp' : 'ArrowLeft']: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select((to + list.length) % list.length, { focus: true });
  };
  let watched = null;
  const scrolled = () => follow();
  // Wide, below a title block: while the row is not yet whole in view, a vertical wheel over it scrolls the window,
  // and stops where the row meets the sticky chrome (--rk-stage-top); then the facets scroll within themselves.
  const stage = (e) => {
    if (!wide || e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.deltaY <= 0) return;
    const top = host.getBoundingClientRect().top - (px('--rk-stage-top', host) || px('--rk-banner-h'));
    const room = document.documentElement.scrollHeight - innerHeight - scrollY;
    if (top <= 1 || room <= 0) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    scrollBy({ top: Math.min(dy, top, room), behavior: 'instant' });
  };
  const resize = () => {
    layout();
    if (watched !== host) {
      if (watched) { watched.removeEventListener('scroll', scrolled); watched.removeEventListener('wheel', stage); }
      watched = host;
      if (host) { host.addEventListener('scroll', scrolled, { passive: true }); host.addEventListener('wheel', stage, { passive: false }); }
    }
    pivotScale(el); pivotFit(el);
  };
  const ro = new ResizeObserver(resize);
  // A title's words change (a count: "questions 2" → "questions 12"): measure again, once per frame.
  let frame = 0;
  const mo = new MutationObserver((records) => {
    if (!realChange(records)) return;
    if (records.some((r) => r.type === 'childList')) sync();          /* a facet came or went */
    cancelAnimationFrame(frame); frame = requestAnimationFrame(resize);
  });
  el.addEventListener('click', click); el.addEventListener('keydown', key); el.addEventListener('wheel', stripWheel, { passive: false });
  ro.observe(el);
  mo.observe(el, { childList: true, characterData: true, subtree: true });
  const first = tabs().map(panel).find(Boolean);
  if (first && first.parentElement) ro.observe(first.parentElement);
  if (first && first.parentElement && first.parentElement.parentElement && first.parentElement.parentElement.classList.contains('rk-facets')) ro.observe(first.parentElement.parentElement);
  last = Math.max(0, chosen());
  sync({ quiet: true });
  resize();
  if (document.fonts) document.fonts.ready.then(resize);
  return {
    select,
    sync: () => sync(),
    get wide() { return wide; },
    get chosen() { const t = tabs()[chosen()]; return t ? (t.dataset.facet || t.id || chosen()) : null; },
    layout: resize,
    destroy() {
      el.removeEventListener('click', click); el.removeEventListener('keydown', key); el.removeEventListener('wheel', stripWheel); ro.disconnect(); mo.disconnect();
      cancelAnimationFrame(frame);
      if (watched) { watched.removeEventListener('scroll', scrolled); watched.removeEventListener('wheel', stage); }
    },
  };
}

// scrollState(root): every scrolled box of a place (the place, a panorama and its sections, a wide facet row and its
// facets, a split's panes, anything marked data-rk-scroll) and the window, as plain data a router can keep with its
// history entry (history.state, SvelteKit's snapshot), and put back on back. Boxes are known by their id or
// data-rk-scroll value, else by their order.
// restore(state) sets every offset it can at once. One it cannot set yet (its box is not there, or still too short or
// narrow for it: data that renders after the navigation, a fetch on mount, a stream) waits, and is set as the boxes
// appear and grow (a MutationObserver and a ResizeObserver on root). It gives up when the user scrolls (the wheel, a
// touch, a press, a scrolling key, or a scroll it did not cause), after duration-restore, or on cancel() or destroy().
const SCROLLERS = '.rk-panorama, .rk-sec, .rk-split-list, .rk-split-detail, [data-rk-wide]:not(.rk-pivot), [data-rk-wide]:not(.rk-pivot) > [role=tabpanel], [data-rk-scroll]';
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
export function scrollState(root) {
  const boxes = () => [root, ...root.querySelectorAll(SCROLLERS)];
  const keyOf = (b, i) => (b === root ? 'root' : b.id ? `#${b.id}` : b.dataset.rkScroll ? `@${b.dataset.rkScroll}` : String(i));
  const runs = new Set();
  function restore(state) {
    if (!state || !state.at) return { pending: false, cancel() {} };
    const page = document.scrollingElement || docEl(), WINDOW = {};
    const want = new Map(Object.entries(state.at)), set = new Map();
    if (typeof state.y === 'number') want.set(WINDOW, [scrollX, state.y]);
    const at = (b, [l, t]) => Math.abs(b.scrollLeft - l) <= 1 && Math.abs(b.scrollTop - t) <= 1;
    // A box scrolls as far as it can towards its offset; it is done once there. What it reached is remembered, so its
    // own scroll event is known for one.
    const put = (key, b, o) => {
      if (!at(b, o)) b.scrollTo({ left: o[0], top: o[1], behavior: 'instant' });
      set.set(b, [b.scrollLeft, b.scrollTop]);
      if (at(b, o)) want.delete(key);
    };
    boxes().forEach((b, i) => { if (!want.has(keyOf(b, i)) && (b.scrollLeft || b.scrollTop)) { b.scrollTo({ left: 0, top: 0, behavior: 'instant' }); set.set(b, [0, 0]); } });
    const pass = () => {
      frame = 0;
      boxes().forEach((b, i) => { const k = keyOf(b, i), o = want.get(k); if (o) put(k, b, o); });
      if (want.has(WINDOW)) put(WINDOW, page, want.get(WINDOW));
      if (!want.size) stop(); else if (live) watch();
    };
    let live = true, frame = 0, timer = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(pass); };
    const mo = new MutationObserver(later), ro = new ResizeObserver(later);
    const watch = () => { for (const b of [root, page, ...root.querySelectorAll(SCROLLERS)]) { ro.observe(b); for (const k of b.children) ro.observe(k); } };
    // The user's own scroll ends it. A box that only lost content (scrolled back to its new end) is not the user's.
    const scrolled = (e) => {
      const b = e.target === document ? page : e.target, s = set.get(b);
      if (!s || (Math.abs(b.scrollLeft - s[0]) <= 1 && Math.abs(b.scrollTop - s[1]) <= 1)) return;
      const clamped = (b.scrollTop < s[1] && b.scrollTop >= b.scrollHeight - b.clientHeight - 1) || (b.scrollLeft < s[0] && b.scrollLeft >= b.scrollWidth - b.clientWidth - 1);
      if (clamped) set.set(b, [b.scrollLeft, b.scrollTop]); else stop();
    };
    const keyed = (e) => { if (SCROLL_KEYS.has(e.key)) stop(); };
    const INPUT = [['wheel', stop], ['touchstart', stop], ['pointerdown', stop], ['keydown', keyed], ['scroll', scrolled]];
    function stop() {
      if (!live) return;
      live = false; runs.delete(run);
      mo.disconnect(); ro.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer);
      for (const [type, fn] of INPUT) removeEventListener(type, fn, { capture: true });
    }
    const run = { get pending() { return live; }, cancel: stop };
    pass();
    if (!live) return run;
    runs.add(run);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    for (const [type, fn] of INPUT) addEventListener(type, fn, { capture: true, passive: true });
    timer = setTimeout(stop, ms('--rk-duration-restore'));
    return run;
  }
  return {
    capture() {
      const at = {};
      boxes().forEach((b, i) => { if (b.scrollLeft || b.scrollTop) at[keyOf(b, i)] = [Math.round(b.scrollLeft), Math.round(b.scrollTop)]; });
      return { y: Math.round(scrollY), at };
    },
    restore,
    destroy() { for (const r of [...runs]) r.cancel(); },
  };
}

// A change in the page, not one of rekta.js's own measuring probes coming and going.
const realChange = (records) => records.some((r) => r.type === 'characterData'
  || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].some((n) => !(n.dataset && 'rkProbe' in n.dataset))));

// strip(el): a strip of links whose current one a router marks (aria-current), as a framework router's place strip:
// measured as a pivot is (the inactive titles' scale, even gaps), the size change played when the mark moves, and the
// glide when the strip does not fit. It routes nothing. Returns { layout, destroy }.
export function strip(el) {
  let frame = 0, last = el.querySelector(':scope > [aria-current]');
  const layout = () => { pivotScale(el); pivotFit(el); };
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
  const mo = new MutationObserver((records) => {
    if (realChange(records)) later();
    const now = el.querySelector(':scope > [aria-current]');
    if (now && now !== last) { last = now; pivotGlide(el, now); }
  });
  const ro = new ResizeObserver(layout);
  mo.observe(el, { attributes: true, attributeFilter: ['aria-current'], childList: true, characterData: true, subtree: true });
  ro.observe(el);
  el.addEventListener('wheel', stripWheel, { passive: false });
  layout();
  if (document.fonts) document.fonts.ready.then(layout);
  return { layout, destroy() { mo.disconnect(); ro.disconnect(); cancelAnimationFrame(frame); el.removeEventListener('wheel', stripWheel); } };
}

// Toaster ------------------------------------------------------------------------------------------------------------
// One toast at a time in a region that stays mounted (role=status, aria-atomic=false). A toast replacing one still
// leaving is inserted once that one has gone, so only what shows is announced. The same key with undo updates the
// open toast and restarts its window. Hover, a touch or focus holds the window. Escape inside a toast dismisses it;
// Ctrl/Cmd+Z undoes while the window is open, except in a text field. Undo is a shortcut, never the only way back.
// A change inside a live region that is not news: the element is a live region of its own, off, while the change is
// read into the accessibility tree, then it follows its region again.
function quietly(el, change) {
  const live = el.getAttribute('aria-live');
  el.setAttribute('aria-live', 'off');
  change();
  setTimeout(() => { if (live === null) el.removeAttribute('aria-live'); else el.setAttribute('aria-live', live); }, 250);
}
export function toaster(region) {
  let open = null;
  const tokenWindow = () => (Math.round(ms('--rk-duration-toast') / 1000) || 5) * 1000;
  function say(msg, text, undoable, again, secs) {
    msg.textContent = text;
    if (!undoable) return;
    const sr = document.createElement('span');
    sr.className = 'rk-toast-sr';
    sr.textContent = tx('undoWindow', secs, again);
    msg.appendChild(sr);
  }
  function show(text, { key = text, undo = null, from = null, action = 'undo', act = null, status = '', windowMs = 0, onEnd = null, title = '', icon: pic = null, picture = '', open: run = null, edge = false } = {}, gauge = null) {
    if (open && open.key === key && open.undo && undo) { open.update(text, undo, { windowMs, onEnd }); return open; }
    if (open) open.leave(false, 'replaced');
    // The window runs against a deadline in wall-clock time, so a late or throttled timer (a busy page, a background
    // tab) never stretches it: each tick reads the clock. remaining is what is left while it stands still (held, or not
    // yet in); an undo toast steps its figure on whole seconds, a plain one goes when it runs out.
    let total = undo ? windowMs || tokenWindow() : ms(gauge ? '--rk-duration-level' : '--rk-duration-toast'), remaining = total;
    let timer = 0, deadline = 0, running = false, hover = false, focus = false, held = false, released = false, done = false, waiting = 0;
    const el = document.createElement('div');
    el.className = 'rk-toast';
    if (status) { el.dataset.status = status; if (status === 'error') el.setAttribute('role', 'alert'); }
    // A notification from another program enters whole from the window's edge: it came from outside (motion.md).
    if (edge) el.setAttribute('data-rk-from', 'edge');
    // A level indicator (toaster.level()): the value's icon, its word, a meter and the figure, no action.
    let bar = null, figure = null;
    if (gauge) {
      el.className = 'rk-toast rk-toast--level';
      if (gauge.icon) el.appendChild(icon(gauge.icon));
    }
    // Its text is pressable when it has a default action ("open what this is about"); a notification without one
    // closes when its text is pressed. It may bring a title, and the sender's icon or its own picture at the start.
    const pressable = !gauge && (!!run || edge);
    const msg = el.appendChild(document.createElement(pressable ? 'button' : 'p'));
    msg.className = 'rk-toast-msg';
    let words = msg;
    if (pressable) {
      msg.type = 'button';
      msg.addEventListener('click', () => { if (run) { leave(false, 'opened'); run(); } else leave(false); });
    }
    if (gauge) {
      bar = el.appendChild(document.createElement('span'));
      bar.className = 'rk-meter'; bar.setAttribute('aria-hidden', 'true');
      figure = el.appendChild(document.createElement('span'));
      figure.className = 'rk-toast-level';
    }
    if (title || pic || picture) {
      if (pic || picture) {
        const field = msg.appendChild(document.createElement('span'));
        field.className = 'rk-toast-pic'; field.setAttribute('aria-hidden', 'true');
        if (picture) { const img = field.appendChild(document.createElement('img')); img.src = picture; img.alt = ''; } else field.appendChild(typeof pic === 'string' ? icon(pic) : pic);
      }
      const body = msg.appendChild(document.createElement('span'));
      body.className = 'rk-toast-body';
      if (title) { const b = body.appendChild(document.createElement('b')); b.className = 'rk-toast-title'; b.textContent = title; }
      words = body.appendChild(document.createElement('span'));
      words.className = 'rk-toast-text';
    }
    let count = null;
    if (undo) {
      const btn = el.appendChild(document.createElement('button'));
      btn.type = 'button'; btn.className = 'rk-toast-act'; btn.setAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
      btn.append(`${action === 'undo' || action === 'redo' ? tx(action) : action} `);
      count = btn.appendChild(document.createElement('span'));
      count.className = 'rk-toast-count'; count.setAttribute('aria-hidden', 'true');
      const line = el.appendChild(document.createElement('span'));
      line.className = 'rk-toast-line'; line.setAttribute('aria-hidden', 'true');
      btn.addEventListener('click', () => leave(true));
    } else if (act) {
      // A plain action ("reload"): no countdown; the toast stays its usual time and holds like any other.
      const btn = el.appendChild(document.createElement('button'));
      btn.type = 'button'; btn.className = 'rk-toast-act'; btn.textContent = act.label;
      btn.addEventListener('click', () => { leave(false, 'acted'); act.run(); });
    }
    const left = () => (running ? Math.max(0, deadline - Date.now()) : remaining);
    const secs = () => Math.max(0, Math.ceil(left() / 1000));
    say(words, text, !!undo, false, secs());
    const paint = () => { if (count) { count.textContent = secs(); el.style.setProperty('--rk-toast-left', total ? left() / total : 0); } };
    function schedule() {
      clearTimeout(timer);
      const l = deadline - Date.now();
      timer = setTimeout(tick, Math.max(0, undo ? l % 1000 || 1000 : l));
    }
    function tick() {
      timer = 0;
      if (!running) return;
      if (deadline - Date.now() <= 0) { running = false; remaining = 0; paint(); leave(false, 'expired'); return; }
      paint(); schedule();
    }
    function go() { if (running || done || waiting) return; running = true; deadline = Date.now() + remaining; schedule(); }
    function stop() { if (!running) return; remaining = Math.max(0, deadline - Date.now()); running = false; clearTimeout(timer); timer = 0; }
    function hold() {
      if (done || waiting) return;
      const was = held;
      held = (hover || focus) && !released;
      if (held) stop(); else go();
      if (held !== was) {
        el.toggleAttribute('data-rk-held', held);
        el.dispatchEvent(new CustomEvent('rk:toasthold', { bubbles: true, detail: { held, remaining: left() } }));
      }
    }
    function leave(doUndo, reason = doUndo ? 'undone' : 'dismissed') {
      if (done) return;
      done = true; running = false; clearTimeout(timer);
      const end = () => { if (doUndo && undo) undo(); if (onEnd) onEnd(doUndo && undo ? 'undone' : reason); };
      if (waiting) { clearTimeout(waiting); waiting = 0; if (open === api) open = null; end(); return; }
      const hadFocus = el.contains(document.activeElement);
      el.setAttribute('data-rk-phase', 'leaving');
      setTimeout(() => el.remove(), ms('--rk-duration-short') * (edge ? 0.6 : 1));
      if (open === api) open = null;
      end();
      if (hadFocus) returnFocus(from);
    }
    // A time the server reports: the window shows what is left of it from now, and 0 ends it, held or not.
    function setRemaining(t) {
      if (done) return;
      const was = running;
      stop();
      remaining = Math.max(0, t); total = Math.max(total, remaining);
      if (!remaining) { paint(); leave(false, 'expired'); return; }
      paint();
      if (was || !held) go();
    }
    const api = {
      key, el, action,
      level: gauge ? gauge.key : null,
      // A level indicator's new value: the meter glides to it, the figure changes, and its time starts again.
      setLevel(v, t) { if (done || !bar) return; bar.style.setProperty('--rk-v', v); figure.textContent = t; setRemaining(ms('--rk-duration-level')); },
      get done() { return done; },
      leave,
      setRemaining,
      // The server no longer extends: the window runs out from here although the pointer or focus rests on it.
      release() { if (done || released) return; released = true; hold(); },
      // A new text, the window left alone; announced once (without the window sentence) only when asked.
      setText(t, { announce = false } = {}) {
        if (done) return;
        const node = words.firstChild && words.firstChild.nodeType === 3 ? words.firstChild : words.insertBefore(document.createTextNode(''), words.firstChild);
        if (announce) node.nodeValue = t; else quietly(el, () => { node.nodeValue = t; });
      },
      get remaining() { return left(); },
      get held() { return held; },
      get released() { return released; },
      undo: undo ? () => leave(true) : null,
      // The same key: a second action joins this toast. Its undo, window and onEnd are the new ones; a previous onEnd
      // replaced by a new one hears 'merged' (its action now rides on the new one), else it stays for the whole toast.
      update(t, u, { windowMs: w = 0, onEnd: e = null } = {}) {
        undo = u;
        if (e) { const before = onEnd; onEnd = e; if (before && before !== e) before('merged'); }
        stop(); released = false;
        total = remaining = w || (undo ? windowMs || tokenWindow() : total);
        say(words, t, !!u, true, secs()); paint(); hold(); if (!held) go();
      },
      sync() { if (running) { clearTimeout(timer); tick(); } },
    };
    el.addEventListener('pointerenter', () => { hover = true; hold(); });
    el.addEventListener('pointerleave', () => { hover = false; hold(); });
    el.addEventListener('focusin', () => { focus = true; hold(); });
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) { focus = false; hold(); } });
    paint();
    if (gauge) { bar.style.setProperty('--rk-v', gauge.value); figure.textContent = gauge.text; }
    open = api;
    const insert = () => { waiting = 0; region.appendChild(el); hold(); if (!held) go(); };
    if (region.querySelector('.rk-toast[data-rk-phase="leaving"]')) waiting = setTimeout(insert, ms('--rk-duration-short')); else insert();
    return api;
  }
  // Back in view (a tab that was in the background), the window catches up with the clock at once.
  const visible = () => { if (open && document.visibilityState === 'visible') open.sync(); };
  document.addEventListener('visibilitychange', visible);
  const offEsc = keys.on(30, (e) => {
    if (e.key !== 'Escape' || !open || !open.el.contains(e.target)) return false;
    open.leave(false); return true;
  });
  const offUndo = keys.on(25, (e) => {
    if (!open || !open.undo || open.action !== 'undo' || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || isEditable(e.target)) return false;
    open.undo(); return true;
  });
  // level(word, value, { icon, text, key }): a level indicator for a value the user changed by a key (volume,
  // brightness, zoom): a toast without an action, an icon, the word, a meter at value (0 to 1) and the figure (text,
  // else the share in per cent). It takes the toast's place like any toast; again while it shows (the same key, the
  // word by default) it stays where it is and only its value glides. It goes timing.level after the last change.
  function level(word, value, { icon: name = '', text = '', key = word } = {}) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    let t = text;
    if (!t) { try { t = new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(v); } catch { t = `${Math.round(v * 100)}%`; } }
    if (open && open.level === key && !open.done) { open.setLevel(v, t); return open; }
    return show(word, { key: `level:${key}` }, { key, value: v, text: t, icon: name });
  }
  return {
    show,
    level,
    get open() { return open; },
    dismiss() { if (open) open.leave(false); },
    destroy() { offEsc(); offUndo(); document.removeEventListener('visibilitychange', visible); },
  };
}

// Banner -------------------------------------------------------------------------------------------------------------
// One lasting system state at a time, the most severe first (order). states: { name: { word, status, alert, text,
// action: label | { label, href }, since: the word before the time, until, on, off } }. set(name, true, { since })
// gives the real start (a Date, or false when it is unknown: no time line); without it the start is now. A new state fades in once and holds still; a change of kind
// glides to its new height; an ending state is an event, so the toaster says so once the banner has gone. Both live
// regions stay mounted. The app bar follows with data-rk-state (halted for error, paused for warning).
export function banner(el, { states, order = Object.keys(states), appbar = null, liveWord = null, toaster: toasts = null, onAction = null } = {}) {
  states = { ...states };                                               // the banner's own copy: update() writes to it
  const alertRegion = el.querySelector('[role=alert]'), statusRegion = el.querySelector('[role=status]');
  const remedy = el.querySelector('.rk-actions .rk-btn');
  let remedyLink = null;                                                // the remedy of a state whose action navigates
  const on = Object.fromEntries(order.map((n) => [n, false])), started = {};
  let shown = null, clearing = 0, setBy = null;
  if (!el.hasAttribute('data-rk-phase') && !el.querySelector('.rk-banner-word')) el.setAttribute('data-rk-phase', 'clear');
  // The banner's height on the root, written once the banner has settled: scroll-padding keeps focus clear of it,
  // and toasts hang below it where anchor positioning is missing.
  let settle = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(() => docEl().style.setProperty('--rk-banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`), 60);
  });
  ro.observe(el, { box: 'border-box' });
  // A start on another day names the day too.
  const when = (d) => {
    if (new Date().toDateString() === d.toDateString()) return clock(d);
    try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d); } catch { return d.toLocaleString(); }
  };
  function write(name) {
    const s = states[name], start = started[name];
    const head = document.createElement('span'); head.className = 'rk-banner-head';
    const word = head.appendChild(document.createElement('span')); word.className = 'rk-banner-word'; word.textContent = s.word || name;
    if (s.until || start) {
      const time = head.appendChild(document.createElement('time')); time.className = 'rk-banner-time';
      if (s.until) { time.dateTime = s.until; time.textContent = `${s.since || strings.since} ${s.until}`; }
      else { time.dateTime = start.toISOString(); time.textContent = `${s.since || strings.since} ${when(start)}`; }
    }
    const msg = document.createElement('span'); msg.className = 'rk-banner-msg'; msg.textContent = s.text;
    alertRegion.replaceChildren(); statusRegion.replaceChildren();
    (s.alert ? alertRegion : statusRegion).replaceChildren(head, msg);
  }
  function show(name) {
    const s = states[name];
    clearTimeout(clearing);
    const standing = el.getAttribute('data-rk-phase') !== 'clear', h0 = el.getBoundingClientRect().height;
    el.removeAttribute('data-rk-phase');
    if (s.status) el.dataset.status = s.status; else delete el.dataset.status;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    write(name);
    if (remedy) {
      const label = s.action && typeof s.action === 'object' ? s.action.label : s.action, href = s.action && s.action.href;
      if (href && !remedyLink) { remedyLink = document.createElement('a'); remedyLink.className = remedy.className; remedy.after(remedyLink); }
      if (remedyLink) { remedyLink.hidden = !href; if (href) { remedyLink.href = href; remedyLink.textContent = label; } }
      remedy.hidden = !!href; remedy.textContent = href ? '' : label || '';
      remedy.parentElement.hidden = !label; remedy.removeAttribute('aria-disabled');
    }
    // A change of kind, or a state that returns while the banner leaves, glides to its new height.
    const h1 = el.getBoundingClientRect().height, d = ms('--rk-duration-short');
    if (standing && d && Math.abs(h1 - h0) >= 1) el.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: d, easing: css('--rk-ease-in') });
  }
  function clear(then) {
    if (el.contains(document.activeElement)) returnFocus(setBy);
    el.setAttribute('data-rk-phase', 'leaving');
    clearing = setTimeout(() => {
      el.setAttribute('data-rk-phase', 'clear');
      delete el.dataset.status;
      alertRegion.replaceChildren(); statusRegion.replaceChildren();
      if (then) then();
    }, ms('--rk-duration-short'));
  }
  function sync(changed, from) {
    const name = order.find((n) => on[n]) || null;
    if (appbar) {
      const top = name && states[name].status;
      if (top === 'error') appbar.setAttribute('data-rk-state', 'halted');
      else if (top === 'warning') appbar.setAttribute('data-rk-state', 'paused');
      else appbar.removeAttribute('data-rk-state');
    }
    if (liveWord) liveWord.textContent = name ? (states[name].word || name) : tx('live');
    if (name === shown) {
      if (changed && toasts) toasts.show(tx('bannerStill', on[changed] ? states[changed].on : states[changed].off.split('.')[0], states[name].word || name), { key: 'state' });
      return;
    }
    const before = shown;
    shown = name;
    if (from) setBy = from;
    if (name) { show(name); if (before && changed && !on[changed] && toasts) toasts.show(states[changed].off, { key: 'state' }); }
    else clear(() => { if (changed && toasts) toasts.show(states[changed].off, { key: 'state' }); });
    el.dispatchEvent(new CustomEvent('rk:bannerchange', { bubbles: true, detail: { state: name } }));
  }
  const act = () => { if (shown && remedy.getAttribute('aria-disabled') !== 'true') (onAction ? onAction(shown) : set(shown, false)); };
  if (remedy) remedy.addEventListener('click', act);
  // A state that is on gets a new sentence (a figure that changes): it is written in place, not announced again, and
  // its start stays.
  function update(name, text) {
    if (!(name in on)) throw new Error(`unknown banner state ${name}`);
    states[name] = { ...states[name], text };
    const m = shown === name && el.querySelector('.rk-banner-msg');
    if (m && m.textContent !== text) quietly(m, () => { m.textContent = text; });
  }
  function set(name, value, { from = null, since, text } = {}) {
    if (!(name in on)) throw new Error(`unknown banner state ${name}`);
    if (on[name] === !!value) { if (value && text !== undefined) update(name, text); return; }
    if (text !== undefined) states[name] = { ...states[name], text };
    on[name] = !!value;
    if (value) { const d = since === false || since === null ? null : since === undefined ? new Date() : new Date(since); started[name] = d && !isNaN(d) ? d : null; }
    sync(name, from);
  }
  sync(null, null);
  return {
    set,
    update,
    toggle(name, opts) { set(name, !on[name], opts); },
    is(name) { return on[name]; },
    get shown() { return shown; },
    destroy() { ro.disconnect(); if (remedy) remedy.removeEventListener('click', act); if (remedyLink) remedyLink.remove(); },
  };
}

// Sheet --------------------------------------------------------------------------------------------------------------
// <dialog class="rk-sheet"> opened with showModal(). A tap on the shading cancels where closedby is not supported.
// It leaves the way it came, back up to the top edge, over duration-short: its answer counts once it has gone.
// sheet(dialog, { dirty }): while dirty() is true, a close request (Escape, the shading, a cancel button) asks first,
// in the sheet itself (one modal at a time): "keep editing" is the answer that is chosen and focused. Calling it again
// for a dialog start() already attached updates its options.
const sheets = new WeakMap();
export function sheet(dialog, opts = {}) {
  const had = sheets.get(dialog);
  if (had) { Object.assign(had.opts, opts); return had.api; }
  const o = { dirty: null, ...opts };
  const close = HTMLDialogElement.prototype.close;
  let leaving = null, ask = null, before = null;
  // The answer is given as the sheet starts to leave. A further close request while it leaves (a tap on the shading,
  // Escape, another button) changes no answer and asks nothing: it only ends the leaving at once.
  function leaveThen(value) {
    const side = dialog.classList.contains('rk-sheet--side');
    const d = ms(side ? '--rk-duration-moderate' : '--rk-duration-short') * 0.8;
    if (!dialog.open) return;
    if (leaving) { leaving.end(); return; }
    if (ask) unask(false);
    if (!d) { close.call(dialog, value); return; }
    dialog.setAttribute('data-rk-phase', 'leaving');
    // The sheet and its shading leave together, as they came: 0.8 × duration-short, easing out; a side panel whole
    // towards its trailing edge, over 0.8 × duration-moderate.
    const ease = css('--rk-ease-out'), away = getComputedStyle(dialog).direction === 'rtl' ? '-100%' : '100%';
    const frames = side ? [{ transform: 'none' }, { transform: `translateX(${away})` }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-16px)' }];
    const anims = [dialog.animate(frames, { duration: d, easing: ease, fill: 'forwards' })];
    try { anims.push(dialog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d, easing: ease, fill: 'forwards', pseudoElement: '::backdrop' })); } catch { /* no pseudo-element animation */ }
    const run = leaving = {
      value,
      end() {
        if (leaving !== run) return;
        leaving = null; dialog.removeAttribute('data-rk-phase'); close.call(dialog, value); anims.forEach((a) => a.cancel());
      },
    };
    finished(anims).then(run.end);
  }
  const isDirty = () => { try { return !!(o.dirty && o.dirty()); } catch { return false; } };
  function askFirst(value) {
    if (ask) return;
    before = document.activeElement;
    const id = uid('rk-ask');
    ask = document.createElement('div');
    ask.className = 'rk-sheet-ask'; ask.setAttribute('role', 'group'); ask.setAttribute('aria-labelledby', id);
    const kicker = ask.appendChild(document.createElement('p')); kicker.className = 'rk-kicker'; kicker.textContent = tx('guardKicker');
    const title = ask.appendChild(document.createElement('h2')); title.className = 'rk-group'; title.id = id; title.textContent = tx('discardTitle');
    const row = ask.appendChild(document.createElement('p')); row.className = 'rk-actions';
    const keep = row.appendChild(document.createElement('button')); keep.type = 'button'; keep.className = 'rk-btn rk-btn--primary'; keep.textContent = tx('guardKeep');
    const drop = row.appendChild(document.createElement('button')); drop.type = 'button'; drop.className = 'rk-btn'; drop.dataset.status = 'error'; drop.textContent = tx('guardDiscard');
    keep.addEventListener('click', () => unask(true));
    drop.addEventListener('click', () => leaveThen(value));
    dialog.setAttribute('data-rk-asking', '');
    dialog.appendChild(ask);
    keep.focus();
  }
  function unask(refocus) {
    if (!ask) return;
    ask.remove(); ask = null; dialog.removeAttribute('data-rk-asking');
    if (refocus && before && before.isConnected) before.focus();
  }
  // A close request: ask when there is something to lose; while asking, it means "keep editing".
  function request(value) {
    if (leaving) { leaving.end(); return; }
    if (ask) { unask(true); return; }
    if (isDirty()) askFirst(value); else leaveThen(value);
  }
  const click = (e) => {
    if ('closedBy' in HTMLDialogElement.prototype || e.target !== dialog || dialog.getAttribute('closedby') === 'closerequest') return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) request('cancel');
  };
  const submit = (e) => {
    if (e.target.getAttribute('method') !== 'dialog' || e.defaultPrevented) return;
    e.preventDefault();
    const value = e.submitter ? e.submitter.value : '';
    if (value === 'cancel') request(value); else leaveThen(value);
  };
  const cancel = (e) => {
    // While it leaves, the browser's own close (one it does not let a page stop) keeps the answer too.
    if (leaving && !e.cancelable) { if (leaving.value !== undefined) dialog.returnValue = leaving.value; return; }
    if (!e.cancelable) { unask(false); return; }
    e.preventDefault(); request('cancel');
  };
  // Escape is taken on its keydown while there is something to lose: there it can always be stopped, where the
  // browser lets a page stop only one cancel event per user activation (a third Escape would close the sheet).
  const key = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !(ask || isDirty())) return;
    e.preventDefault(); request('cancel');
  };
  const closed = () => unask(false);
  if (!dialog.hasAttribute('closedby')) dialog.setAttribute('closedby', 'any');
  dialog.close = (value) => leaveThen(value);
  // The page behind stops scrolling while the sheet is open; the root keeps its scrollbar's room as padding
  // (--rk-scrollbar, measured here), so nothing shifts and the sheet still spans the viewport.
  const showModal = HTMLDialogElement.prototype.showModal;
  dialog.showModal = () => { docEl().style.setProperty('--rk-scrollbar', `${Math.max(0, innerWidth - docEl().clientWidth)}px`); showModal.call(dialog); };
  dialog.addEventListener('keydown', key);
  dialog.addEventListener('click', click);
  dialog.addEventListener('submit', submit);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', closed);
  const api = {
    get asking() { return !!ask; },
    destroy() {
      unask(false); sheets.delete(dialog);
      dialog.removeEventListener('click', click); dialog.removeEventListener('submit', submit); dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', closed);
      dialog.removeEventListener('keydown', key);
      delete dialog.close; delete dialog.showModal;
    },
  };
  sheets.set(dialog, { opts: o, api });
  return api;
}

// inPlace(scope): choosing in place (docs/states.md). A control with data-rk-in="ID" opens the element with that id (a
// list, hidden until then) in the place of the group that holds the control (its closest [data-rk-group], else its
// parent): the group hides and the list shows, under a row "back · name" (.rk-in-back, made when the list has none;
// name is the control's data-rk-in-name, else the list's aria-label), and focus goes to the list's first control.
// That row, Escape and ← (outside a text field) go back one level: the list hides, the group shows, focus returns to
// the control that opened it. Levels may nest. Each step slides in like the next item of a place, back from the other
// side. Escape here goes back before it would close the sheet or panel around it.
export function inPlace(scope) {
  const open = [];                                     // { control, group, list }, innermost last
  const slide = (el, dir) => {
    const d = ms('--rk-duration-moderate') * 0.75;
    if (d) el.animate([{ transform: `translateX(${dir * num('--rk-slide-distance')}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: d, easing: css('--rk-ease-out') });
  };
  const focusIn = (el) => { const f = el.querySelector('[aria-selected="true"], [aria-checked="true"], :checked, a[href], button:not(.rk-in-back), input, select, [tabindex]:not([tabindex="-1"])') || el.querySelector('.rk-in-back'); if (f) f.focus(); };
  function go(control) {
    const list = document.getElementById(control.dataset.rkIn);
    if (!list) return;
    const group = control.closest('[data-rk-group]') || control.parentElement;
    let back = list.querySelector(':scope > .rk-in-back');
    if (!back) {
      back = document.createElement('button');
      back.type = 'button'; back.className = 'rk-in-back';
      back.append(icon('chevron-left'), tx('inBack', control.dataset.rkInName || list.getAttribute('aria-label') || control.textContent.replace(/\s+/g, ' ').trim()));
      list.prepend(back);
    }
    open.push({ control, group, list });
    group.hidden = true; list.hidden = false;
    slide(list, 1); focusIn(list);
  }
  function out() {
    const top = open.pop();
    if (!top) return false;
    top.list.hidden = true; top.group.hidden = false;
    slide(top.group, -1);
    if (top.control.isConnected) top.control.focus();
    return true;
  }
  const click = (e) => {
    const t = e.target.closest && e.target.closest('[data-rk-in], .rk-in-back');
    if (!t || !scope.contains(t)) return;
    if (t.matches('.rk-in-back')) { if (open.length && open[open.length - 1].list.contains(t)) out(); return; }
    e.preventDefault(); go(t);
  };
  const key = (e) => {
    if (!open.length || e.defaultPrevented || e.isComposing || isEditable(e.target)) return;
    const top = open[open.length - 1];
    if (!top.list.contains(e.target)) return;
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !e.target.closest('[role=slider], input[type=range], [role=tree], [role=tablist]'))) { e.preventDefault(); e.stopPropagation(); out(); }
  };
  scope.addEventListener('click', click);
  scope.addEventListener('keydown', key);
  return {
    get depth() { return open.length; },
    back: out,
    reset() { while (open.length) out(); },
    destroy() { scope.removeEventListener('click', click); scope.removeEventListener('keydown', key); },
  };
}

// Data states ------------------------------------------------------------------------------------------------------
// busy(region, work): the region is aria-busy while work (a promise or a function returning one) runs. The line shows
// only after busy-delay (CSS), and once shown stays at least busy-min, so an answer never makes it flash. Resolves or
// rejects with the work.
export async function busy(region, work) {
  const t0 = performance.now();
  region.setAttribute('aria-busy', 'true');
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    const shown = performance.now() - t0 - ms('--rk-duration-busy-delay');
    if (shown > 0) await new Promise((r) => setTimeout(r, Math.max(0, ms('--rk-duration-busy-min') - shown)));
    region.removeAttribute('aria-busy');
  }
}
// pending(button, work, { label }): the button says what it is doing ("saving…") at the same width, refuses further
// clicks, and runs the line under it after busy-delay. Label: the option, data-rk-pending-label, or its text plus "…".
// The line goes with the label, in one step, and no busy-min holds it: the label coming back says the end.
export async function pending(button, work, { label } = {}) {
  if (button.hasAttribute('data-rk-pending')) return undefined;
  const nodes = [...button.childNodes], width = button.offsetWidth;
  const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  button.style.minWidth = `${width}px`;
  button.textContent = label || button.dataset.rkPendingLabel || `${button.textContent.trim()}…`;
  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('data-rk-pending', '');
  button.addEventListener('click', block, true);
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    button.removeEventListener('click', block, true);
    button.replaceChildren(...nodes);
    button.removeAttribute('data-rk-pending');
    button.removeAttribute('aria-disabled');
    button.style.minWidth = '';
  }
}

// Floating surfaces -------------------------------------------------------------------------------------------------
// place(el, anchor, { align }): puts a fixed floating surface next to its control, by one rule (docs/states.md, the same
// in rekta-core): space-xs from the control, space-m from the window's edges (the stylesheet's width limit). Below when
// it fits there; else above when it fits there; else on the side with more room, kept inside the window, where it may
// cover the control and its content scrolls. Aligned to the control's leading edge, or with align 'center' (the
// default for a control marked data-rk-align="center") to its centre; either way inside the window. data-rk-side says
// which side it took.
export function place(el, anchor, { align = anchor.getAttribute('data-rk-align') === 'center' ? 'center' : 'start' } = {}) {
  const a = anchor.getBoundingClientRect(), gap = px('--rk-space-xs'), edge = px('--rk-space-m');
  el.style.left = '0px'; el.style.top = '0px'; el.style.right = 'auto'; el.style.bottom = 'auto';   /* over a stylesheet's own placement */
  el.style.maxHeight = '';
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  if (el.offsetHeight > vh - 2 * edge) el.style.maxHeight = `${Math.max(0, vh - 2 * edge)}px`;
  const w = el.offsetWidth, h = el.offsetHeight;
  const below = vh - a.bottom - gap - edge, above = a.top - gap - edge;
  const side = h <= below ? 'below' : h <= above ? 'above' : below >= above ? 'below' : 'above';
  const top = side === 'below' ? a.bottom + gap : a.top - gap - h;
  // From the control's leading edge; one too near the trailing edge for that opens from its trailing edge instead.
  const left = align === 'center' ? a.left + a.width / 2 - w / 2 : a.left + w <= vw - edge ? a.left : Math.min(a.right, vw - edge) - w;
  el.style.left = `${Math.round(Math.max(edge, Math.min(left, vw - edge - w)))}px`;
  el.style.top = `${Math.round(Math.max(edge, Math.min(top, vh - edge - h)))}px`;
  el.dataset.rkSide = side;
}
const canPopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
function openFloat(el) { if (canPopover) { if (!el.matches(':popover-open')) el.showPopover(); } else { el.hidden = false; el.setAttribute('data-rk-open', ''); } }
function closeFloat(el) { if (canPopover) { if (el.matches(':popover-open')) el.hidePopover(); } else { el.hidden = true; el.removeAttribute('data-rk-open'); } }
const isOpen = (el) => (canPopover ? el.matches(':popover-open') : !el.hidden);

// menu(trigger, el, { onSelect }): a menu button. el is a .rk-float of .rk-menu-item buttons (role menuitem,
// menuitemcheckbox or menuitemradio), opened by a click, Enter, Space or ↓ (↑ from the end). In the menu: ↑ ↓ wrap,
// Home End, letters jump (typeAhead); Enter or Space chooses; Escape, Tab or a click outside
// closes and focus returns to the trigger after a choice or Escape. A checkbox item toggles and leaves the menu open,
// so several can be ticked in a row. With summary ("status"), the trigger says what is ticked: "status: failed, done",
// or "status: any" when nothing is (a filter button). align goes to place(): by default the trigger's data-rk-align.
// A second level stands in place of the list (docs/states.md): an item with aria-haspopup="menu" and aria-controls
// names a .rk-menu-level (role menu, hidden) inside the menu; → Enter or Space opens it under a "back" row with its
// name, the surface keeping its width and place; ← or Escape goes back one level, focus to the item that opened it.
export function menu(trigger, el, { onSelect, summary = null, align } = {}) {
  el.id = el.id || `rk-menu-${Math.random().toString(36).slice(2, 8)}`;
  el.setAttribute('role', 'menu');
  if (canPopover) el.setAttribute('popover', 'auto'); else el.hidden = true;
  el.classList.add('rk-float');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-controls', el.id);
  trigger.setAttribute('aria-expanded', 'false');
  const items = () => [...el.querySelectorAll('.rk-menu-item')].filter((i) => i.getClientRects().length);
  const focusItem = (i) => { const list = items(); if (list.length) list[(i + list.length) % list.length].focus(); };
  const find = typeAhead();
  function summarize() {
    if (!summary) return;
    const on = [...el.querySelectorAll('[aria-checked="true"]')].map((i) => i.textContent.trim());
    trigger.textContent = tx('chosen', summary, on.length ? on.join(', ') : tx('any'));
  }
  summarize();
  // With popovers the trigger is the menu's invoker: the browser toggles it on click and a click on the trigger
  // never counts as a click outside. Placement and focus follow the toggle.
  let first = 0;
  if (canPopover && 'popoverTargetElement' in trigger) trigger.popoverTargetElement = el;
  const levelOf = (item) => { const id = item && item.getAttribute('aria-haspopup') === 'menu' && item.getAttribute('aria-controls'); const l = id && document.getElementById(id); return l && el.contains(l) ? l : null; };
  const openLevels = () => [...el.querySelectorAll('.rk-menu-level:not([hidden])')];
  // The level in sight: its rows stand in place of the list, under a back row with the level's name. The surface
  // keeps its width and place (moved back inside the window only when the level does not fit there); nothing moves.
  function enter(item) {
    const level = levelOf(item);
    if (!level || item.getAttribute('aria-disabled') === 'true') return false;
    let back = level.querySelector(':scope > .rk-menu-back');
    if (!back) {
      back = level.insertBefore(document.createElement('button'), level.firstChild);
      back.type = 'button'; back.className = 'rk-menu-item rk-menu-back'; back.setAttribute('role', 'menuitem');
      back.textContent = level.getAttribute('aria-label') || item.textContent.trim();
      back.setAttribute('aria-label', `${tx('back')}: ${back.textContent}`);
    }
    el.style.minWidth = `${el.offsetWidth}px`;
    level.hidden = false;
    item.setAttribute('aria-expanded', 'true');
    reflow();
    const rows = items();
    (rows[rows.indexOf(back) + 1] || back).focus();
    return true;
  }
  function out() {
    const level = openLevels().pop();
    if (!level) return false;
    const item = el.querySelector(`[aria-controls="${CSS.escape(level.id)}"]`);
    level.hidden = true;
    if (item) { item.setAttribute('aria-expanded', 'false'); item.focus(); }
    if (!openLevels().length) el.style.minWidth = '';
    reflow();
    return true;
  }
  const reset = () => { openLevels().forEach((l) => { l.hidden = true; }); el.querySelectorAll('[aria-haspopup="menu"][aria-expanded]').forEach((i) => i.setAttribute('aria-expanded', 'false')); el.style.minWidth = ''; };
  const shown = () => { place(el, trigger, { align }); trigger.setAttribute('aria-expanded', 'true'); focusItem(first); first = 0; };
  function open(at = 0) {
    if (isOpen(el)) { focusItem(at); return; }
    first = at;
    openFloat(el);
    if (!canPopover) shown();
  }
  function close(refocus = true) {
    if (!isOpen(el)) return;
    closeFloat(el);
    reset();
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  }
  const toggle = (e) => { if (e.newState === 'open') shown(); else { trigger.setAttribute('aria-expanded', 'false'); reset(); } };
  const click = (e) => {
    if (canPopover && trigger.popoverTargetElement === el) return;                    // the browser toggles
    e.preventDefault(); if (isOpen(el)) close(); else open(0);
  };
  const triggerKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp' ? -1 : 0); }
  };
  const key = (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
    else if (e.key === 'ArrowRight' && levelOf(list[i])) { e.preventDefault(); enter(list[i]); }
    else if (e.key === 'ArrowLeft' && openLevels().length) { e.preventDefault(); out(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (!out()) close(); }
    else if (e.key === 'Tab') close(false);
    else { const hit = find(e, list, list[i]); if (hit) { e.preventDefault(); hit.focus(); } }
  };
  const choose = (e) => {
    const item = e.target.closest('.rk-menu-item');
    if (!item || item.getAttribute('aria-disabled') === 'true') { if (item) e.preventDefault(); return; }
    if (item.classList.contains('rk-menu-back')) { out(); return; }
    if (enter(item)) return;
    const checkbox = item.getAttribute('role') === 'menuitemcheckbox';
    if (checkbox) item.setAttribute('aria-checked', String(item.getAttribute('aria-checked') !== 'true'));
    if (item.getAttribute('role') === 'menuitemradio') el.querySelectorAll('[role=menuitemradio]').forEach((r) => r.setAttribute('aria-checked', String(r === item)));
    summarize();
    if (!checkbox) close(); else if (!canPopover || el.matches(':popover-open')) place(el, trigger, { align });
    if (onSelect) onSelect(item);
  };
  const outside = (e) => { if (!canPopover && isOpen(el) && !el.contains(e.target) && !trigger.contains(e.target)) close(false); };
  function reflow() { if (isOpen(el)) place(el, trigger, { align }); }
  trigger.addEventListener('click', click);
  trigger.addEventListener('keydown', triggerKey);
  el.addEventListener('keydown', key);
  el.addEventListener('click', choose);
  el.addEventListener('toggle', toggle);
  document.addEventListener('pointerdown', outside, true);
  addEventListener('resize', reflow);
  addEventListener('scroll', reflow, true);
  return {
    open, close,
    // Set the checkbox items from outside (a filter restored from the address); the trigger follows.
    set(checked) { el.querySelectorAll('[role=menuitemcheckbox]').forEach((i) => i.setAttribute('aria-checked', String(checked(i)))); summarize(); },
    destroy() {
      trigger.removeEventListener('click', click); trigger.removeEventListener('keydown', triggerKey);
      el.removeEventListener('keydown', key); el.removeEventListener('click', choose); el.removeEventListener('toggle', toggle);
      document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', reflow); removeEventListener('scroll', reflow, true);
    },
  };
}

// Selection ----------------------------------------------------------------------------------------------------------
// select(el, { items, onShow, onChange, appbar }): Metro selection over the items of a list (li) or a table body (tr).
// A click selects an item and shows it (onShow), the way a file list does. Ctrl/Cmd+click adds or removes an item and
// starts the selection mode: then every click adds or removes, until the selection is empty or Escape ends it.
// Shift+click selects the range from the last item. Keys: ↑ ↓ (← → in a grid) Home End move the focus, and letters
// jump (typeAhead: an item's aria-label, a row's th, else its text); Space and Enter act as a click, Ctrl/Cmd+Space as
// a Ctrl+click; Ctrl/Cmd+A selects all. A selected item takes the accent fill
// and a checkmark; it nudges where it is pressed (data-rk-press). Items a filter hides drop out. With an appbar, the
// bar carries the selection in the mode (data-rk-selecting, .rk-ab-count, [data-rk-clear]).
const selecting = new WeakMap();                                       // app bar → the selections in their mode
function selectionMode(appbar, owner, mode, n) {
  const modes = selecting.get(appbar) || new Set();
  selecting.set(appbar, modes);
  if (mode) modes.add(owner); else modes.delete(owner);
  const was = appbar.hasAttribute('data-rk-selecting');
  appbar.toggleAttribute('data-rk-selecting', modes.size > 0);
  if (was && !modes.size) { appbar.setAttribute('data-rk-unselecting', ''); setTimeout(() => appbar.removeAttribute('data-rk-unselecting'), ms('--rk-duration-short') + 20); }
  const c = appbar.querySelector('.rk-ab-count');
  if (c && (mode || !modes.size)) c.textContent = tx('selected', n);
  return modes.size > 0;
}
export function select(el, { items = ':scope > li, :scope > tr', onShow = null, onChange = null, appbar = null } = {}) {
  const list = () => [...el.querySelectorAll(items)];
  const visible = () => list().filter((i) => !i.hidden);
  const chosen = () => list().filter((i) => i.getAttribute('aria-selected') === 'true');
  const isTable = el.tagName === 'TBODY';
  const host = isTable ? el.closest('table') : el;
  let mode = false, anchor = null;
  const find = typeAhead(), nameOf = (i) => i.getAttribute('aria-label') || (i.querySelector(':scope > th') || i).textContent;
  host.setAttribute('role', isTable ? 'grid' : 'listbox');
  host.setAttribute('aria-multiselectable', 'true');
  el.setAttribute('data-rk-select', '');
  function prepare() {
    const all = list();
    for (const i of all) {
      if (!isTable) i.setAttribute('role', 'option');
      if (!i.hasAttribute('aria-selected')) i.setAttribute('aria-selected', 'false');
      i.setAttribute('data-rk-press', '');
      if (i.hidden && i.getAttribute('aria-selected') === 'true') i.setAttribute('aria-selected', 'false');
    }
    const focusable = all.filter((i) => !i.hidden);
    if (!focusable.some((i) => i.tabIndex === 0)) { const first = chosen().find((i) => !i.hidden) || focusable[0]; if (first) first.tabIndex = 0; }
    for (const i of all) if (i.tabIndex !== 0 || i.hidden) i.tabIndex = -1;
  }
  function roving(item) { for (const i of list()) i.tabIndex = i === item ? 0 : -1; }
  function sync() {
    const n = chosen().length;
    if (!n) mode = false;
    el.toggleAttribute('data-rk-selecting', mode);
    if (appbar) {
      selectionMode(appbar, el, mode, n);
      if (!mode && appbar.contains(document.activeElement)) { const t = chosen()[0] || visible()[0]; if (t) t.focus(); }
    }
    if (onChange) onChange(chosen(), { mode });
    el.dispatchEvent(new CustomEvent('rk:selectionchange', { bubbles: true, detail: { count: n, mode, items: chosen() } }));
  }
  const set = (i, on) => i.setAttribute('aria-selected', String(on));
  // only(item): a plain choice. The item alone is selected and shown.
  function only(item, { show = true } = {}) {
    mode = false;
    for (const i of list()) set(i, i === item);
    if (item) { anchor = item; roving(item); }
    sync();
    if (show && item && onShow) onShow(item);
  }
  function toggle(item) {
    if (!mode) { mode = true; }
    set(item, item.getAttribute('aria-selected') !== 'true');
    anchor = item; roving(item);
    sync();
  }
  function range(item, add) {
    const vis = visible(), a = anchor && vis.includes(anchor) ? anchor : vis[0];
    const [x, y] = [vis.indexOf(a), vis.indexOf(item)].sort((m, n) => m - n);
    if (!add) for (const i of list()) set(i, false);
    vis.slice(x, y + 1).forEach((i) => set(i, true));
    mode = chosen().length > 1;
    roving(item);
    sync();
  }
  function act(item, { add = false, extend = false } = {}) {
    if (extend) range(item, add);
    else if (add || mode) toggle(item);
    else only(item);
  }
  const click = (e) => {
    const item = e.target.closest(items.replace(/:scope > /g, ''));
    if (!item || item.parentElement !== el || e.button !== 0) return;
    const inner = e.target.closest(CONTROL);
    if (inner && item.contains(inner)) return;                        // a control inside the item acts on its own
    if (e.target.closest('a[href]')) e.preventDefault();               // the item's title link: the click selects
    e.stopPropagation();
    act(item, { add: e.ctrlKey || e.metaKey, extend: e.shiftKey });
    item.focus({ preventScroll: true });
  };
  const key = (e) => {
    const item = e.target.closest && e.target.closest(items.replace(/:scope > /g, ''));
    if (!item || item.parentElement !== el || e.altKey) return;
    if (isEditable(e.target) || (e.target !== item && e.target.closest(CONTROL))) return;
    const vis = visible(), i = vis.indexOf(item);
    const cols = !isTable && getComputedStyle(el).display === 'grid' ? getComputedStyle(el).gridTemplateColumns.split(' ').length : 1;
    const to = { ArrowDown: i + cols, ArrowUp: i - cols, ArrowRight: cols > 1 ? i + 1 : undefined, ArrowLeft: cols > 1 ? i - 1 : undefined, Home: 0, End: vis.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = vis[Math.max(0, Math.min(vis.length - 1, to))];
      if (e.shiftKey) range(next, mode); else roving(next);
      next.focus();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); act(item, { add: e.ctrlKey || e.metaKey, extend: e.shiftKey }); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); mode = true; for (const v of vis) set(v, true); sync(); return; }
    if (e.target !== item) return;
    const hit = find(e, vis, item, nameOf);
    if (hit) { e.preventDefault(); roving(hit); hit.focus(); }
  };
  const offEsc = keys.on(20, (e) => {
    if (e.key !== 'Escape' || !mode || isEditable(e.target)) return false;
    if (!el.contains(e.target) && !(appbar && appbar.contains(e.target))) return false;
    clear(); return true;
  });
  function clear() { for (const i of list()) set(i, false); mode = false; sync(); }
  const clearClick = (e) => { if (e.target.closest('[data-rk-clear]')) clear(); };
  el.addEventListener('click', click);
  el.addEventListener('keydown', key);
  if (appbar) appbar.addEventListener('click', clearClick);
  prepare();
  sync();
  return {
    selected: chosen, only, toggle, clear,
    selectAll() { mode = true; for (const v of visible()) set(v, true); sync(); },
    get mode() { return mode; },
    refresh() { prepare(); sync(); },
    destroy() {
      el.removeEventListener('click', click); el.removeEventListener('keydown', key); offEsc();
      if (appbar) { appbar.removeEventListener('click', clearClick); selectionMode(appbar, el, false, 0); }
    },
  };
}

// Table ------------------------------------------------------------------------------------------------------------
// table(el, { onSort, select, onShow, onSelect, appbar }): a .rk-table. A sort button in a head cell sorts by its
// column, ascending then descending, with the rows moving to their new places (FLIP); onSort takes over for data
// sorted elsewhere. With select (or a .rk-check cell in its rows), rows are selected the Metro way (select()). Cells
// get data-label from their head for the stacked layout of a narrow place.
export function table(el, { onSort, select: selectable = null, onShow = null, onSelect = null, appbar = null, columns = null, edit = null } = {}) {
  const head = () => (el.tHead ? [...el.tHead.rows[0].cells] : []);
  const rows = () => (el.tBodies[0] ? [...el.tBodies[0].rows] : []);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function label() {
    const names = head().map((th) => th.textContent.trim());
    for (const r of rows()) [...r.cells].forEach((c, i) => { if (!c.hasAttribute('data-label') && !c.classList.contains('rk-check') && names[i]) c.dataset.label = names[i]; });
  }
  const value = (cell) => (cell ? (cell.dataset.sort !== undefined ? cell.dataset.sort : cell.textContent.trim()) : '');
  function sortRows(column, dir) {
    const list = rows(), body = el.tBodies[0];
    const before = list.length <= 200 ? new Map(list.map((r) => [r, r.getBoundingClientRect().top])) : null;
    const sign = dir === 'descending' ? -1 : 1;
    list.sort((a, b) => {
      const x = value(a.cells[column]), y = value(b.cells[column]), nx = Number(x), ny = Number(y);
      return sign * (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : collator.compare(x, y));
    }).forEach((r) => body.appendChild(r));
    const d = ms('--rk-duration-moderate');
    if (before && d) for (const r of list) {
      const dy = before.get(r) - r.getBoundingClientRect().top;
      if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: d, easing: css('--rk-ease-base') });
    }
  }
  function sort(th, dir) {
    for (const h of head()) if (h !== th && h.hasAttribute('aria-sort')) h.setAttribute('aria-sort', 'none');
    th.setAttribute('aria-sort', dir);
    if (onSort) onSort({ column: th.cellIndex, dir, th }); else sortRows(th.cellIndex, dir);
  }
  const click = (e) => {
    const sorter = e.target.closest('.rk-sort');
    if (sorter) { const th = sorter.closest('th'); sort(th, th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending'); }
  };
  el.addEventListener('click', click);
  label();
  const wantSelect = selectable !== null ? selectable : !!el.querySelector('tbody .rk-check');
  const sel = wantSelect && el.tBodies[0] ? select(el.tBodies[0], { items: ':scope > tr', onShow, onChange: onSelect, appbar }) : null;

  // Columns: a handle on each head cell's trailing edge drags its width (← → by space-m, Shift: four times; a double
  // click resets); hide(i) and show(i) take a column out and back. Both are remembered under columns.key.
  const cols = columns ? (columns === true ? {} : columns) : null;
  const saved = { w: {}, hidden: [] };
  const store = { get() { try { return cols && cols.key ? JSON.parse(localStorage.getItem(cols.key) || 'null') : null; } catch { return null; } }, set() { try { if (cols && cols.key) localStorage.setItem(cols.key, JSON.stringify(saved)); } catch { /* this visit only */ } } };
  const cells = (i) => [head()[i], ...rows().map((r) => r.cells[i])].filter(Boolean);
  function fix() {
    if (el.style.tableLayout === 'fixed') return;
    head().forEach((th) => { if (!th.hidden && !th.style.width) th.style.width = `${th.offsetWidth}px`; });
    el.style.tableLayout = 'fixed';
  }
  function setWidth(i, w, remember = true) {
    const th = head()[i];
    fix();
    th.style.width = `${Math.round(Math.max(48, w))}px`;
    const h = th.querySelector('.rk-col-handle');
    if (h) h.setAttribute('aria-valuenow', String(Math.round(th.offsetWidth)));
    if (remember) { saved.w[i] = th.offsetWidth; store.set(); }
  }
  function resetWidth(i) {
    const before = head().map((th) => th.offsetWidth);
    delete saved.w[i]; store.set();
    if (!Object.keys(saved.w).length) { el.style.tableLayout = ''; head().forEach((th) => { th.style.width = ''; }); } else head()[i].style.width = '';
    const d = ms('--rk-duration-short');
    if (d) head().forEach((th, k) => { const w = th.offsetWidth; if (Math.abs(w - before[k]) > 1) th.animate([{ width: `${before[k]}px` }, { width: `${w}px` }], { duration: d, easing: css('--rk-ease-base') }); });
  }
  function hideCol(i, hidden = true) {
    cells(i).forEach((c) => { c.hidden = hidden; });
    saved.hidden = hidden ? [...new Set([...saved.hidden, i])] : saved.hidden.filter((x) => x !== i);
    store.set();
  }
  let resizing = null;
  const colDown = (e) => {
    const h = e.target.closest('.rk-col-handle');
    if (!h || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const th = h.closest('th');
    resizing = { i: th.cellIndex, x: e.clientX, w: th.offsetWidth, h };
    h.setPointerCapture(e.pointerId); h.setAttribute('data-rk-dragging', '');
  };
  const colMove = (e) => { if (resizing) setWidth(resizing.i, resizing.w + (e.clientX - resizing.x) * (getComputedStyle(el).direction === 'rtl' ? -1 : 1), false); };
  const colUp = () => { if (!resizing) return; saved.w[resizing.i] = head()[resizing.i].offsetWidth; store.set(); resizing.h.removeAttribute('data-rk-dragging'); resizing = null; };
  const colKey = (e) => {
    const h = e.target.closest('.rk-col-handle');
    if (!h) return;
    const i = h.closest('th').cellIndex, step = (num('--rk-space-m') || 16) * (e.shiftKey ? 4 : 1), w = head()[i].offsetWidth;
    if (e.key === 'ArrowRight') setWidth(i, w + step); else if (e.key === 'ArrowLeft') setWidth(i, w - step);
    else if (e.key === 'Home') setWidth(i, 48); else return;
    e.preventDefault();
  };
  const colDbl = (e) => { const h = e.target.closest('.rk-col-handle'); if (h) resetWidth(h.closest('th').cellIndex); };
  if (cols) {
    head().forEach((th) => {
      if (th.classList.contains('rk-check') || th.querySelector('.rk-col-handle')) return;
      const h = document.createElement('span');
      h.className = 'rk-col-handle'; h.tabIndex = 0;
      h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical');
      h.setAttribute('aria-label', tx('columnWidth', th.textContent.trim()));
      th.appendChild(h);
    });
    const was = store.get();
    if (was) { Object.entries(was.w || {}).forEach(([i, w]) => setWidth(+i, w)); (was.hidden || []).forEach((i) => hideCol(+i)); }
    el.addEventListener('pointerdown', colDown); el.addEventListener('pointermove', colMove);
    el.addEventListener('pointerup', colUp); el.addEventListener('pointercancel', colUp);
    el.addEventListener('keydown', colKey); el.addEventListener('dblclick', colDbl);
  }

  // Editing: a cell with data-rk-edit edits in place on a double click, or F2 on its row (the row's first such cell).
  // Enter or Tab keeps the value (Tab goes on to the next editable cell, Shift+Tab back), Escape puts the old one
  // back. edit.onCommit(row, cell, value, old) may return a promise: the cell waits, and a refusal says why below it
  // and keeps the field open.
  let editing = null;
  function startEdit(td) {
    if (!edit || !td || editing) return;
    const old = td.dataset.value !== undefined ? td.dataset.value : td.textContent.trim();
    const input = document.createElement('input');
    input.className = 'rk-input rk-cell-input'; input.value = old;
    input.setAttribute('aria-label', `${td.dataset.label || head()[td.cellIndex].textContent.trim()}, ${td.parentElement.querySelector('th') ? td.parentElement.querySelector('th').textContent.trim() : ''}`);
    editing = { td, old, input };
    td.setAttribute('data-rk-editing', '');
    td.replaceChildren(input);
    input.focus(); input.select();
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(old, true); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const list = [...td.parentElement.querySelectorAll('td[data-rk-edit]')], next = list[list.indexOf(td) + (e.shiftKey ? -1 : 1)];
        commit().then((ok) => { if (ok && next) startEdit(next); });
      }
    };
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', () => { if (editing && editing.input === input && !td.hasAttribute('aria-busy')) commit(); });
  }
  async function commit() {
    if (!editing) return false;
    const { td, old, input } = editing, value = input.value.trim();
    if (value === old) { finish(old); return true; }
    td.setAttribute('aria-busy', 'true'); input.readOnly = true;
    const said = td.querySelector('.rk-cell-error'); if (said) said.remove();
    try {
      await (edit.onCommit ? edit.onCommit(td.parentElement, td, value, old) : null);
      finish(value);
      return true;
    } catch (err) {
      td.removeAttribute('aria-busy'); input.readOnly = false;
      td.dataset.status = 'error'; input.setAttribute('aria-invalid', 'true');
      const msg = document.createElement('span');
      msg.className = 'rk-cell-error'; msg.id = uid('rk-cell-error'); msg.textContent = (err && err.message) || tx('cellRefused');
      td.appendChild(msg); input.setAttribute('aria-describedby', msg.id);
      input.focus();
      return false;
    }
  }
  function finish(value, cancelled = false) {
    if (!editing) return;
    const { td } = editing;
    editing = null;
    td.removeAttribute('data-rk-editing'); td.removeAttribute('aria-busy'); delete td.dataset.status;
    td.textContent = value; if (td.dataset.value !== undefined) td.dataset.value = value;
    const row = td.parentElement;
    if (row.tabIndex >= 0 || row.hasAttribute('tabindex')) row.focus({ preventScroll: true });
    if (!cancelled) el.dispatchEvent(new CustomEvent('rk:edit', { bubbles: true, detail: { row, cell: td, value } }));
  }
  const editDbl = (e) => { const td = e.target.closest('td[data-rk-edit]'); if (td && el.contains(td) && !e.target.closest('input')) startEdit(td); };
  const editKey = (e) => { if (e.key === 'F2' && e.target.matches('tr')) { e.preventDefault(); startEdit(e.target.querySelector('td[data-rk-edit]')); } };
  if (edit) { el.addEventListener('dblclick', editDbl); el.addEventListener('keydown', editKey); }

  return {
    selected: () => (sel ? sel.selected() : []),
    only: (row, o) => sel && sel.only(row, o),
    clear: () => sel && sel.clear(),
    selectAll: () => sel && sel.selectAll(),
    get mode() { return sel ? sel.mode : false; },
    sort: (column, dir = 'ascending') => sort(head()[column], dir),
    hide: (i) => hideCol(i, true), show: (i) => hideCol(i, false),
    hidden: () => [...saved.hidden],
    width: (i, w) => (w === undefined ? resetWidth(i) : setWidth(i, w)),
    edit: (cell) => startEdit(cell),
    refresh() { label(); saved.hidden.forEach((i) => cells(i).forEach((c) => { c.hidden = true; })); if (sel) sel.refresh(); },
    destroy() {
      el.removeEventListener('click', click); if (sel) sel.destroy();
      el.removeEventListener('pointerdown', colDown); el.removeEventListener('pointermove', colMove); el.removeEventListener('pointerup', colUp);
      el.removeEventListener('pointercancel', colUp); el.removeEventListener('keydown', colKey); el.removeEventListener('dblclick', colDbl);
      el.removeEventListener('dblclick', editDbl); el.removeEventListener('keydown', editKey);
    },
  };
}

// Split ------------------------------------------------------------------------------------------------------------
// split(el, { key }): a .rk-split of .rk-split-list, .rk-split-handle and .rk-split-detail. Sideways both panes show;
// the handle drags the list's width (--rk-split-w), ← → move it by space-m (Shift: four times), Home End to the
// limits, a double click resets it; the width is remembered under key. Compact, one pane shows at a time:
// show('detail') turns to the detail, show('list') back to the list, with the turnstile. sideways says which.
export function split(el, { key = null } = {}) {
  const list = el.querySelector(':scope > .rk-split-list'), detail = el.querySelector(':scope > .rk-split-detail');
  const handle = el.querySelector(':scope > .rk-split-handle');
  const isSideways = () => getComputedStyle(el).display === 'grid';
  let showing = 'list', was = null;
  const store = { get() { try { return key && parseFloat(localStorage.getItem(key)); } catch { return NaN; } }, set(v) { try { if (key) localStorage.setItem(key, String(v)); } catch { /* this visit only */ } } };
  function limits() { const min = px('--rk-pane-min') || 240; return [min, Math.max(min, el.clientWidth - min - 1)]; }
  function setWidth(px, remember = true) {
    const [min, max] = limits(), w = Math.round(Math.min(max, Math.max(min, px)));
    el.style.setProperty('--rk-split-w', `${w}px`);
    if (handle) { handle.setAttribute('aria-valuenow', String(w)); handle.setAttribute('aria-valuemin', String(Math.round(min))); handle.setAttribute('aria-valuemax', String(Math.round(max))); }
    if (remember) store.set(w);
  }
  function sync() {
    const now = isSideways();
    if (now === was) return;
    was = now;
    turn.finish();
    if (now) { list.hidden = false; detail.hidden = false; }
    else { list.hidden = showing !== 'list'; detail.hidden = showing !== 'detail'; }
  }
  // show(which, { focus }): compact, turns to that pane (the list comes back as a back turn); sideways, nothing moves.
  async function show(which, { focus = null, animate = true } = {}) {
    if (which === showing) return;
    showing = which;
    if (isSideways()) return;
    const from = which === 'detail' ? list : detail, to = which === 'detail' ? detail : list, back = which === 'list';
    if (animate && !from.hidden) { await turn.leave(from, { back }); await turn.enter(to, { back, focus, arriving: false }); }
    else { from.hidden = true; to.hidden = false; if (focus) focus.focus({ preventScroll: true }); }
  }
  // reveal(dir): sideways, the detail's new item slides in from its side, as a facet does.
  function reveal(dir = 1) {
    const d = ms('--rk-duration-moderate') * 0.75;
    if (d && isSideways()) detail.animate([{ transform: `translateX(${dir * num('--rk-slide-distance')}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: d, easing: css('--rk-ease-out') });
  }
  let drag = null;
  const down = (e) => { if (e.button > 0) return; drag = { x: e.clientX, w: list.getBoundingClientRect().width }; handle.setPointerCapture(e.pointerId); handle.setAttribute('data-rk-dragging', ''); e.preventDefault(); };
  const move = (e) => { if (drag) setWidth(drag.w + (e.clientX - drag.x), false); };
  const up = () => { if (!drag) return; drag = null; handle.removeAttribute('data-rk-dragging'); setWidth(list.getBoundingClientRect().width); };
  const keydown = (e) => {
    const [min, max] = limits(), w = list.getBoundingClientRect().width, step = num('--rk-space-m') * (e.shiftKey ? 4 : 1);
    const to = { ArrowLeft: w - step, ArrowRight: w + step, Home: min, End: max }[e.key];
    if (to === undefined) return;
    e.preventDefault(); setWidth(to);
  };
  const reset = () => { el.style.removeProperty('--rk-split-w'); if (key) try { localStorage.removeItem(key); } catch { /* ignore */ } setWidth(list.getBoundingClientRect().width, false); };
  if (handle) {
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    if (!handle.hasAttribute('tabindex')) handle.tabIndex = 0;
    if (list.id) handle.setAttribute('aria-controls', list.id);
    handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    handle.addEventListener('keydown', keydown); handle.addEventListener('dblclick', reset);
  }
  const ro = new ResizeObserver(() => { sync(); if (isSideways() && handle) setWidth(list.getBoundingClientRect().width, false); });
  ro.observe(el);
  const saved = store.get();
  if (saved) el.style.setProperty('--rk-split-w', `${saved}px`);
  sync();
  return {
    show, reveal,
    get sideways() { return isSideways(); },
    get showing() { return showing; },
    destroy() {
      ro.disconnect();
      if (handle) { handle.removeEventListener('pointerdown', down); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.removeEventListener('keydown', keydown); handle.removeEventListener('dblclick', reset); }
    },
  };
}

// How well a label matches what was typed: every typed word must start a word of the label or its keywords (3 when the
// label starts with the text, 2 otherwise), or the label must contain the text (1); 0 is no match.
const words = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function matchScore(label, keywords, q) {
  if (!q) return 1;
  const hay = words(`${label} ${keywords || ''}`), l = label.toLowerCase();
  if (!words(q).every((w) => hay.some((h) => h.startsWith(w)))) return l.includes(q.toLowerCase()) ? 1 : 0;
  return l.startsWith(q.toLowerCase()) ? 3 : 2;
}

// Palette ----------------------------------------------------------------------------------------------------------
// palette(el, { items, trigger, router, shortcut }): go to a place or run a command, from a list that rises from the
// app bar at every width. el is a .rk-palette holding an input and a list; items() returns { label, group, keys,
// keywords, href | run }. Typing filters (every word must start a word of the label or its keywords); ↑ ↓ move,
// Enter runs, Escape clears the text, then closes. Ctrl/Cmd+K (shortcut) opens it from anywhere.
export function palette(el, { items = () => [], trigger = null, router = null, shortcut = 'k' } = {}) {
  const input = el.querySelector('input'), list = el.querySelector('ul, ol');
  el.id = el.id || `rk-palette-${Math.random().toString(36).slice(2, 8)}`;
  list.id = list.id || `${el.id}-list`;
  if (canPopover) el.setAttribute('popover', 'auto'); else el.hidden = true;
  el.classList.add('rk-float');
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('autocomplete', 'off'); input.spellcheck = false;
  list.setAttribute('role', 'listbox');
  if (trigger) { trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', el.id); trigger.setAttribute('aria-expanded', 'false'); }
  let shown = [], active = 0, opener = null;
  const match = (it, q) => matchScore(it.label, it.keywords, q);
  function render() {
    const q = input.value.trim(), all = (typeof items === 'function' ? items() : items) || [];
    const groups = [];
    for (const it of all) if (!groups.includes(it.group || '')) groups.push(it.group || '');
    shown = [];
    all.forEach((it, i) => { const score = match(it, q); if (score) shown.push({ it, score, i }); });
    shown.sort((a, b) => groups.indexOf(a.it.group || '') - groups.indexOf(b.it.group || '') || (q ? b.score - a.score : 0) || a.i - b.i);
    active = 0;
    list.replaceChildren();
    let group = null;
    shown.forEach(({ it }, k) => {
      if ((it.group || '') !== group) {
        group = it.group || '';
        if (group) { const h = document.createElement('li'); h.className = 'rk-menu-label'; h.setAttribute('role', 'presentation'); h.textContent = group; list.appendChild(h); }
      }
      const li = document.createElement('li');
      li.className = 'rk-menu-item'; li.id = `${el.id}-o${k}`; li.setAttribute('role', 'option');
      li.append(it.label);
      if (it.keys) { const kk = document.createElement('span'); kk.className = 'rk-menu-key'; kk.textContent = it.keys; li.appendChild(kk); }
      li.addEventListener('pointermove', () => mark(k));
      li.addEventListener('click', () => run(k));
      list.appendChild(li);
    });
    if (!shown.length) {
      const li = document.createElement('li'); li.className = 'rk-empty rk-palette-empty'; li.setAttribute('role', 'presentation');
      li.textContent = tx('paletteEmpty', q); list.appendChild(li);
    }
    mark(0);
  }
  function mark(k) {
    if (!shown.length) { input.removeAttribute('aria-activedescendant'); return; }
    active = (k + shown.length) % shown.length;
    list.querySelectorAll('[role=option]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
    const o = list.querySelector(`#${CSS.escape(`${el.id}-o${active}`)}`);
    input.setAttribute('aria-activedescendant', o.id);
    o.scrollIntoView({ block: 'nearest' });
  }
  function open() {
    if (isOpen(el)) { input.focus(); return; }
    opener = document.activeElement;
    input.value = '';
    openFloat(el);
    render();
    input.setAttribute('aria-expanded', 'true');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function close(refocus = true) {
    if (!isOpen(el)) return;
    closeFloat(el);
    input.setAttribute('aria-expanded', 'false');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (refocus && opener && opener.isConnected) opener.focus();
  }
  function run(k) {
    const pick = shown[k];
    if (!pick) return;
    close(!pick.it.href);
    if (pick.it.href) { if (router) router.navigate(pick.it.href); else location.href = pick.it.href; }
    else if (pick.it.run) pick.it.run();
  }
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mark(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; render(); } else close(); }
    else if (e.key === 'Tab') e.preventDefault();
  };
  const toggle = (e) => { if (e.newState === 'closed') { input.setAttribute('aria-expanded', 'false'); if (trigger) trigger.setAttribute('aria-expanded', 'false'); } };
  // A pointer press on the trigger would light-dismiss the open palette first; the click then reopens it. Remember.
  let wasOpen = false;
  const down = () => { wasOpen = isOpen(el); };
  const triggerClick = (e) => { e.preventDefault(); if (wasOpen) { wasOpen = false; return; } open(); };
  const offKey = keys.on(5, (e) => {
    if (!shortcut || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== shortcut) return false;
    if (isOpen(el)) close(); else open();
    return true;
  });
  const outside = (e) => { if (!canPopover && isOpen(el) && !el.contains(e.target) && !(trigger && trigger.contains(e.target))) close(false); };
  input.addEventListener('input', render);
  input.addEventListener('keydown', key);
  el.addEventListener('toggle', toggle);
  document.addEventListener('pointerdown', outside, true);
  if (trigger) { trigger.addEventListener('pointerdown', down); trigger.addEventListener('click', triggerClick); }
  return {
    open, close,
    get isOpen() { return isOpen(el); },
    destroy() {
      input.removeEventListener('input', render); input.removeEventListener('keydown', key); el.removeEventListener('toggle', toggle);
      document.removeEventListener('pointerdown', outside, true); offKey();
      if (trigger) { trigger.removeEventListener('pointerdown', down); trigger.removeEventListener('click', triggerClick); }
    },
  };
}

// App bar ----------------------------------------------------------------------------------------------------------
// appbar(el, { more }): controls that do not fit move into a "more" menu, the least important first (data-rk-priority,
// higher stays longer, none is 0; then from the end). more is a .rk-ab button shown only while something has moved;
// its menu repeats each moved control's words (its key hint apart, as the palette shows it), and choosing one clicks
// the control; a control that cannot act (disable()) is a disabled item whose label names the reason. Back, the live
// state, a selection's controls and data-rk-priority="pinned" never move (pinned ones do
// while the bar holds the places, which come first). While the bar holds the places, data-rk-places is on the bar and the root, and rekta.css leaves the places' top strip out.
const placesBars = new Set();                                         // bars holding the places: the root says so while any does
const markPlaces = (bar, on) => { if (on) placesBars.add(bar); else placesBars.delete(bar); bar.toggleAttribute('data-rk-places', on); docEl().toggleAttribute('data-rk-places', placesBars.size > 0); };
export function appbar(el, { more = el.querySelector('.rk-ab-more') } = {}) {
  if (!more) return { layout() {}, destroy() {} };
  const pop = document.createElement('div');
  pop.className = 'rk-float rk-ab-menu';
  el.appendChild(pop);
  const words = (c) => {
    if (c.hasAttribute('aria-label')) return c.getAttribute('aria-label').trim();
    const copy = c.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"], .rk-key').forEach((x) => x.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };
  const keyHint = (c) => shortcutText(c) || ((c.querySelector('.rk-key') || {}).textContent || '').trim();
  // Running things (.rk-ab-run) give way before any command, the latest started first and the one in front last.
  const runRank = (c) => (!c.classList.contains('rk-ab-run') ? 2 : /^(true|page)$/.test(c.getAttribute('aria-current') || '') ? 1 : 0);
  const candidates = (pinned = false) => [...el.querySelectorAll(':scope > .rk-ab')].filter((c) => c !== more && !c.classList.contains('rk-ab-back') && c.dataset.rkAlign !== 'center' && (pinned || c.dataset.rkPriority !== 'pinned'))
    .map((c, i) => ({ c, i, r: runRank(c), p: Number(c.dataset.rkPriority || 0) }))
    .sort((a, b) => a.r - b.r || a.p - b.p || b.i - a.i).map((x) => x.c);
  function build() {
    pop.replaceChildren(...[...el.querySelectorAll(':scope > .rk-ab[data-rk-overflow]')].map((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rk-menu-item'; b.setAttribute('role', 'menuitem'); b.textContent = words(c);
      if (c.getAttribute('aria-disabled') === 'true' || c.disabled) {
        const why = document.getElementById(c.dataset.rkWhy || '');
        b.setAttribute('aria-disabled', 'true');
        if (why && why.textContent.trim()) b.textContent = tx('cannotAct', words(c), why.textContent.trim());
      }
      const k = keyHint(c);
      if (k) {
        const kk = b.appendChild(document.createElement('span')); kk.className = 'rk-menu-key'; kk.setAttribute('aria-hidden', 'true'); kk.textContent = k;
        if (c.hasAttribute('aria-keyshortcuts')) b.setAttribute('aria-keyshortcuts', c.getAttribute('aria-keyshortcuts'));
      }
      b._rkFor = c;
      return b;
    }));
  }
  const fits = () => el.scrollWidth <= el.clientWidth + 1;
  const placesShown = () => { const p = el.querySelector(':scope > .rk-ab-places'); return !!p && getComputedStyle(p).display !== 'none'; };
  // Two sides around a control in the middle (a clock, data-rk-align="center"; docs/navigation.md). Each side has half
  // the bar less half that control. A side that does not fit gives its own controls away, least important first:
  // giving away one of the other side's would not help. "more" ends the trailing side. The middle line cuts before
  // the centred control, pinned (up to half the bar) or not, and is gone only while the leading side has given
  // controls away (data-rk-full="start"). The centred control stands at the bar's centre (--_rk-shift).
  function twoSides(c) {
    const cs = getComputedStyle(el), gap = parseFloat(cs.columnGap) || 0;
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const room = (inner - c.offsetWidth) / 2 - gap;
    const mid = el.querySelector(':scope > .rk-ab-mid');
    const kidsOf = (lead) => [...el.children].filter((k) => k !== pop && k !== c && k !== mid && !!(k.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) === lead);
    const width = (list) => { const v = list.filter((k) => k.getClientRects().length); return v.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + Math.max(0, v.length - 1) * gap; };
    const lead = kidsOf(true), trail = kidsOf(false), full = [];
    el.style.removeProperty('--_rk-mid-max');
    const pinned = mid && mid.dataset.rkPriority === 'pinned';
    const midNeed = pinned ? Math.min(mid.scrollWidth, inner / 2) + gap : 0;
    for (const x of candidates().filter((k) => lead.includes(k))) { if (width(lead) + midNeed <= room) break; x.setAttribute('data-rk-overflow', ''); full.push('start'); }
    if (mid) el.style.setProperty('--_rk-mid-max', `${Math.max(0, Math.floor(room - width(lead) - (lead.some((k) => k.getClientRects().length) ? gap : 0)))}px`);
    if (full.length || width(trail) > room) more.hidden = false;
    for (const x of candidates().filter((k) => trail.includes(k))) { if (width(trail) <= room) break; x.setAttribute('data-rk-overflow', ''); full.push('end'); }
    if (full.length) el.setAttribute('data-rk-full', [...new Set(full)].join(' ')); else el.removeAttribute('data-rk-full');
    const b = el.getBoundingClientRect(), r = c.getBoundingClientRect(), was = parseFloat(el.style.getPropertyValue('--_rk-shift')) || 0;
    el.style.setProperty('--_rk-shift', `${Math.round(b.left + b.width / 2 - (r.left - was + r.width / 2))}px`);
  }
  function layout() {
    if (el.hasAttribute('data-rk-selecting')) return;
    el.querySelectorAll(':scope > [data-rk-overflow]').forEach((c) => c.removeAttribute('data-rk-overflow'));
    el.removeAttribute('data-rk-full');
    more.hidden = true;
    const withPlaces = placesShown(), centred = el.querySelector(':scope > .rk-ab[data-rk-align="center"]');
    markPlaces(el, withPlaces);
    if (withPlaces) {                                 /* the places hold the bar: every command is in "more", pinned too */
      const all = candidates(true);
      if (all.length) { more.hidden = false; all.forEach((c) => c.setAttribute('data-rk-overflow', '')); }
    } else if (centred && centred.getClientRects().length) twoSides(centred);
    else if (!fits()) {
      more.hidden = false;
      for (const c of candidates()) { if (fits()) break; c.setAttribute('data-rk-overflow', ''); }
    }
    build();
  }
  const m = menu(more, pop, { onSelect: (item) => { if (item._rkFor) item._rkFor.click(); } });
  const rebuild = () => build();
  more.addEventListener('pointerdown', rebuild); more.addEventListener('keydown', rebuild);
  // It lays out again when the bar's width changes, when its children change, and when a child grows or shrinks by
  // itself (the live word a banner writes, a pinned middle, a web font arriving). Sizes its own layout causes are
  // remembered, so they do not set it off again.
  const sizes = new WeakMap();
  const kids = () => [...el.children].filter((c) => c !== pop);
  const remember = () => { for (const c of kids()) sizes.set(c, Math.round(c.getBoundingClientRect().width)); };
  let frame = 0;
  const relayout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { layout(); remember(); }); };
  const ro = new ResizeObserver(relayout);
  ro.observe(el);
  const kro = new ResizeObserver((entries) => {
    if (entries.some((e) => sizes.get(e.target) !== Math.round(e.target.getBoundingClientRect().width))) relayout();
  });
  const watch = () => kids().forEach((c) => kro.observe(c));
  const mo = new MutationObserver(() => { watch(); relayout(); });   // places or commands a framework renders later
  mo.observe(el, { childList: true });
  watch();
  layout(); remember();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  return {
    layout() { layout(); remember(); },
    destroy() {
      cancelAnimationFrame(frame); ro.disconnect(); kro.disconnect(); mo.disconnect(); m.destroy();
      more.removeEventListener('pointerdown', rebuild); more.removeEventListener('keydown', rebuild); pop.remove();
      markPlaces(el, false);
    },
  };
}

// Forms ------------------------------------------------------------------------------------------------------------
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const controlsOf = (form) => [...form.querySelectorAll('input, select, textarea')].filter((c) => !/^(button|submit|reset|image|hidden)$/.test(c.type));
const labelOf = (c) => { const l = c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`); return ((l && l.textContent) || c.getAttribute('aria-label') || c.name || tx('field')).replace(/\s+/g, ' ').trim(); };

// disable(control, reason): a control that cannot act now, and says why next to it (a .rk-hint linked by
// aria-describedby). It stays focusable (aria-disabled), so the reason is read with it; clicks do nothing.
// An app-bar control (.rk-ab) has no room beside it: its reason is its tooltip (data-rk-tip, shown on a resting
// pointer, keyboard focus or a tap), read from a hidden element linked the same way; in "more" its item says it.
// disable(control, null) enables it again.
export function disable(control, reason) {
  const id = control.dataset.rkWhy || uid('rk-why');
  control.dataset.rkWhy = id;
  let hint = document.getElementById(id);
  const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== id);
  const bar = control.matches('.rk-ab');
  if (!control._rkBlock) control._rkBlock = (e) => { if (control.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); } };
  if (reason) {
    control.disabled = false;
    control.setAttribute('aria-disabled', 'true');
    if (!hint) {
      hint = document.createElement('span'); hint.className = bar ? 'rk-why' : 'rk-hint rk-why'; hint.id = id; hint.hidden = bar;
      control.after(hint);
    }
    hint.textContent = reason;
    if (bar) {
      if (!('_rkTipWas' in control)) control._rkTipWas = control.getAttribute('data-rk-tip');
      control.setAttribute('data-rk-tip', reason);
    }
    control.setAttribute('aria-describedby', [...ids, id].join(' '));
    control.addEventListener('click', control._rkBlock, true);
  } else {
    control.removeAttribute('aria-disabled');
    if (hint) hint.remove();
    if ('_rkTipWas' in control) {
      if (control._rkTipWas === null) control.removeAttribute('data-rk-tip'); else control.setAttribute('data-rk-tip', control._rkTipWas);
      delete control._rkTipWas;
      if (tip.for === control) hideTip(false);
    }
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
    control.removeEventListener('click', control._rkBlock, true);
  }
}

// confirm({ title, text, kicker, ok, cancel, safe }): a short question in a sheet; resolves true when ok is chosen.
// The safe answer is the primary button and takes focus: for an action that cannot be undone, safe: 'cancel', and ok
// is then the destructive button (data-status="error", forms.md). Escape and a tap on the shading answer cancel.
export function confirm({ title, text = '', kicker = '', ok = tx('ok'), cancel = tx('cancel'), safe = 'ok', root = document.querySelector('.rk') || document.body } = {}) {
  const d = document.createElement('dialog');
  d.className = 'rk-sheet';
  const tid = uid('rk-confirm');
  d.setAttribute('aria-labelledby', tid);
  const f = d.appendChild(document.createElement('form'));
  f.method = 'dialog';
  if (kicker) { const k = f.appendChild(document.createElement('p')); k.className = 'rk-kicker'; k.textContent = kicker; }
  const h = f.appendChild(document.createElement('h2')); h.className = 'rk-group'; h.id = tid; h.textContent = title;
  if (text) { const t = f.appendChild(document.createElement('p')); t.textContent = text; }
  const row = f.appendChild(document.createElement('p')); row.className = 'rk-actions';
  const b = (label, value) => { const x = row.appendChild(document.createElement('button')); x.className = `rk-btn${safe === value ? ' rk-btn--primary' : ''}`; x.value = value; x.textContent = label; if (safe === value) x.autofocus = true; return x; };
  const opener = document.activeElement;
  b(cancel, 'cancel');
  const yes = b(ok, 'ok');
  if (safe === 'cancel') yes.dataset.status = 'error';
  root.appendChild(d);
  const sh = sheet(d);
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      sh.destroy();
      resolve(d.returnValue === 'ok');
      setTimeout(() => d.remove(), ms('--rk-duration-short'));
      if (opener && opener.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true });
    }, { once: true });
    d.showModal();
  });
}

// form(el, { validators, onSubmit, submit }): checks a form late and corrects it early. validators maps a control's
// id to fn(value, control) → a cause-and-remedy sentence, or nothing. A field is checked when it is left after an
// edit, and again on every keystroke while it shows an error. On submit with errors, a summary at the top of the form
// (.rk-errors: "2 fields need attention", a link to each) takes focus. Without errors, onSubmit(values) runs while
// the submit button is pending; it may reject with { fields: { id: message } } (the server said no to a field) or
// { message } (to the whole form), which show the same way. Returns { check, setErrors, clear, destroy }.
export function form(el, { validators = {}, onSubmit = null, submit = el.querySelector('[type=submit]') } = {}) {
  el.noValidate = true;
  const edited = new Set();
  const fieldOf = (c) => c.closest('.rk-field') || c.parentElement;
  function hintOf(c) {
    const f = fieldOf(c);
    let h = f.querySelector('.rk-hint:not(.rk-why)');
    if (!h) { h = document.createElement('span'); h.className = 'rk-hint'; f.appendChild(h); }
    if (!h.id) h.id = uid('rk-hint');
    const ids = (c.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.includes(h.id)) c.setAttribute('aria-describedby', [...ids, h.id].join(' '));
    if (h.dataset.rkHint === undefined) h.dataset.rkHint = h.textContent;
    return h;
  }
  function setError(c, msg) {
    const f = fieldOf(c), h = hintOf(c);
    if (msg) { f.dataset.status = 'error'; c.setAttribute('aria-invalid', 'true'); h.textContent = msg; }
    else { if (f.dataset.status === 'error') delete f.dataset.status; c.removeAttribute('aria-invalid'); h.textContent = h.dataset.rkHint; }
  }
  const run = (c) => { const v = validators[c.id]; return v ? v(c.type === 'checkbox' ? c.checked : c.value, c) || null : null; };
  const check1 = (c) => { const m = run(c); setError(c, m); return m; };
  function errors() { return controlsOf(el).map((c) => ({ c, m: el.querySelector(`#${CSS.escape(c.id)}[aria-invalid="true"]`) ? hintOf(c).textContent : null })).filter((x) => x.m); }
  let box = null;
  function summarize(list, message = null) {
    if (!list.length && !message) { if (box) { box.remove(); box = null; } return; }
    if (!box) {
      box = document.createElement('div'); box.className = 'rk-errors'; box.tabIndex = -1; box.setAttribute('role', 'group');
      el.prepend(box);
    }
    const hid = uid('rk-errors');
    box.setAttribute('aria-labelledby', hid);
    const head = document.createElement('p'); head.id = hid;
    head.textContent = message || tx('needAttention', list.length);
    const ul = document.createElement('ul');
    for (const { c, m } of list) {
      const a = document.createElement('a'); a.href = `#${c.id}`; a.textContent = `${labelOf(c)}: ${m}`;
      a.addEventListener('click', (e) => { e.preventDefault(); c.focus(); });
      ul.appendChild(document.createElement('li')).appendChild(a);
    }
    box.replaceChildren(head, ...(list.length ? [ul] : []));
    box.focus();
  }
  function check() { const list = []; for (const c of controlsOf(el)) { const m = check1(c); if (m) list.push({ c, m }); } return list; }
  function setErrors(map = {}, message = null) {
    const list = [];
    for (const [id, m] of Object.entries(map)) { const c = el.querySelector(`#${CSS.escape(id)}`); if (c) { setError(c, m); list.push({ c, m }); } }
    summarize(list, message && !list.length ? message : null);
  }
  const values = () => Object.fromEntries(controlsOf(el).filter((c) => c.id || c.name).map((c) => [c.id || c.name, c.type === 'checkbox' ? c.checked : c.value]));
  const input = (e) => { edited.add(e.target); if (e.target.getAttribute('aria-invalid') === 'true') check1(e.target); };
  const blur = (e) => { if (edited.has(e.target)) check1(e.target); };
  const onsubmit = async (e) => {
    e.preventDefault();
    const list = check();
    if (list.length) { summarize(list); return; }
    summarize([]);
    if (!onSubmit) return;
    try { await (submit ? pending(submit, () => onSubmit(values())) : onSubmit(values())); }
    catch (err) { if (err && err.fields) setErrors(err.fields, err.message); else summarize([], (err && err.message) || tx('saveFailed')); }
  };
  el.addEventListener('input', input);
  el.addEventListener('focusout', blur);
  el.addEventListener('submit', onsubmit);
  return {
    check, setErrors,
    clear() { edited.clear(); controlsOf(el).forEach((c) => setError(c, null)); summarize([]); },
    get errors() { return errors(); },
    destroy() { el.removeEventListener('input', input); el.removeEventListener('focusout', blur); el.removeEventListener('submit', onsubmit); },
  };
}

// guard(el, { router, what }): unsaved input is not lost by accident. While the form differs from how it was
// loaded (or last saved: clean()), leaving its place asks "Leave without saving?" (keep editing is the safe answer)
// and closing the window asks the browser's question. Discarding puts the form back as it was.
export function guard(el, { router = null, what = tx('guardWhat') } = {}) {
  const state = (c) => (c.type === 'checkbox' || c.type === 'radio' ? c.checked : c.value);
  let saved = new Map();
  const clean = () => { saved = new Map(controlsOf(el).map((c) => [c, state(c)])); };
  const changed = () => controlsOf(el).filter((c) => saved.has(c) && saved.get(c) !== state(c));
  const restore = () => { for (const [c, v] of saved) { if (c.type === 'checkbox' || c.type === 'radio') c.checked = v; else c.value = v; } el.dispatchEvent(new Event('rk:restored', { bubbles: true })); };
  clean();
  const unload = (e) => { if (changed().length) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', unload);
  const place = el.closest('[data-rk-place]');
  const off = router ? router.guard(() => {
    const n = changed().length;
    if (!n || (place && place.dataset.rkPlace !== router.current)) return true;
    return confirm({ kicker: tx('guardKicker'), title: tx('guardTitle'), text: tx('guardText', what, n), ok: tx('guardDiscard'), cancel: tx('guardKeep'), safe: 'cancel' })
      .then((leave) => { if (leave) restore(); return leave; });
  }) : () => {};
  return { get dirty() { return changed().length > 0; }, changed, clean, restore, destroy() { removeEventListener('beforeunload', unload); off(); } };
}

// Tooltip ----------------------------------------------------------------------------------------------------------
// tips(): a short ink label for a control that has one (data-rk-tip="text"; the control's aria-keyshortcuts adds
// its keys), or for text its box cuts off (data-rk-tip="overflow": the element's own text, only while it is cut). It
// shows after tip-delay under a mouse or pen, at once after another tip or on keyboard focus; on touch only a tap on
// a disabled control (aria-disabled) shows its tip, the reason it cannot act (disable() in the app bar).
// Escape, a press, scrolling or leaving hide it. It repeats or completes what the control says: never the only way to
// learn what it does. start() turns it on.
const tip = { el: null, for: null, timer: 0, hid: 0, described: null, on: false };
// A combination is written one way (navigation.md, "Writing a key"): the modifiers in the order Ctrl, Alt, Shift, Meta,
// then the key, joined by "+" ("Ctrl+Shift+Z"); on Apple, the symbols with no separator ("⇧⌘Z"). Meta outside Apple
// is the catalogue's keyMeta: "Win" on Windows, "Super" elsewhere.
const KEY_NAMES = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
const APPLE_KEYS = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isWindows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform || navigator.userAgent);
function keyName(k) {
  if (isMac && APPLE_KEYS[k]) return APPLE_KEYS[k];
  if (k === 'Meta') return tx('keyMeta', isWindows ? 'windows' : 'other');
  return KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
}
function shortcutText(el) {
  const all = (el.getAttribute('aria-keyshortcuts') || '').split(/\s+/).filter(Boolean);
  const pick = all.find((k) => (isMac ? /Meta/.test(k) : !/Meta/.test(k))) || all[0];
  if (!pick) return '';
  const rank = (k) => { const i = MODIFIERS.indexOf(k); return i < 0 ? MODIFIERS.length : i; };
  return pick.split('+').sort((a, b) => rank(a) - rank(b)).map(keyName).join(isMac ? '' : '+');
}
function tipText(el) {
  const t = el.getAttribute('data-rk-tip');
  if (t === 'overflow') return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 ? el.textContent.trim() : '';
  return t || '';
}
function placeTip(t, anchor) {
  const a = anchor.getBoundingClientRect(), gap = px('--rk-tip-gap'), edge = px('--rk-space-m');
  t.style.left = '0px'; t.style.top = '0px';
  const w = t.offsetWidth, h = t.offsetHeight, vw = document.documentElement.clientWidth;
  const above = a.top - gap - h >= edge;
  t.style.left = `${Math.round(Math.min(Math.max(edge, a.left + a.width / 2 - w / 2), vw - w - edge))}px`;
  t.style.top = `${Math.round(above ? a.top - gap - h : a.bottom + gap)}px`;
  t.dataset.rkSide = above ? 'above' : 'below';
}
function showTip(el, given = null) {
  clearTimeout(tip.timer); tip.timer = 0;
  const text = given || tipText(el), keysText = given ? '' : shortcutText(el);
  if (!text || !el.isConnected) return;
  if (tip.for && tip.for !== el) hideTip(false);
  if (!tip.el) {
    tip.el = document.createElement('div');
    tip.el.className = 'rk-tip'; tip.el.id = 'rk-tip'; tip.el.setAttribute('role', 'tooltip');
    if (canPopover) tip.el.setAttribute('popover', 'manual'); else tip.el.hidden = true;
    (document.querySelector('.rk') || document.body).appendChild(tip.el);
  }
  tip.el.replaceChildren(text);
  if (keysText) { const k = document.createElement('span'); k.className = 'rk-key'; k.textContent = keysText; tip.el.append(' ', k); }
  openFloat(tip.el); placeTip(tip.el, el);
  // It describes its control while it shows, unless it repeats the control's name or a description it already has
  // (a disabled app-bar control's reason).
  const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
  const said = (el.getAttribute('aria-describedby') || '').split(/\s+/).some((d) => { const x = d && document.getElementById(d); return x && x.textContent.trim() === text; });
  if (text !== name && !said) { tip.described = el.getAttribute('aria-describedby'); el.setAttribute('aria-describedby', `${tip.described ? `${tip.described} ` : ''}rk-tip`); }
  else tip.described = undefined;
  tip.for = el;
}
function hideTip(remember = true) {
  clearTimeout(tip.timer); tip.timer = 0;
  if (!tip.for) return;
  const el = tip.for;
  if (tip.described !== undefined) { if (tip.described) el.setAttribute('aria-describedby', tip.described); else el.removeAttribute('aria-describedby'); }
  closeFloat(tip.el); tip.for = null;
  if (remember) tip.hid = Date.now();
}
function tips() {
  if (tip.on) return { destroy() {} };
  tip.on = true;
  const over = (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest && e.target.closest('[data-rk-tip]');
    if (!el || el === tip.for) return;
    clearTimeout(tip.timer);
    const wait = ms('--rk-duration-tip-delay');
    if (tip.for || Date.now() - tip.hid < wait) showTip(el); else tip.timer = setTimeout(() => showTip(el), wait);
  };
  const out = (e) => {
    if (e.pointerType === 'touch') return;                           // a lifted finger leaves: a tapped tip stays
    const el = e.target.closest && e.target.closest('[data-rk-tip]');
    if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
    if (tip.for === el || tip.timer) hideTip();
  };
  const focus = (e) => { const el = e.target.closest && e.target.closest('[data-rk-tip]'); if (el && e.target.matches(':focus-visible')) showTip(el); };
  const blur = (e) => { if (tip.for && tip.for.contains(e.target)) hideTip(); };
  const away = () => hideTip();
  // A tap cannot rest: on a control that cannot act anyway it shows the reason, until the next press or a scroll.
  const tap = (e) => {
    const el = e.pointerType === 'touch' && e.target.closest && e.target.closest('[aria-disabled="true"][data-rk-tip]');
    if (el) showTip(el);
  };
  const offEsc = keys.on(45, (e) => { if (e.key !== 'Escape' || !tip.for) return false; hideTip(); return true; });
  document.addEventListener('pointerup', tap);
  document.addEventListener('pointerover', over); document.addEventListener('pointerout', out);
  document.addEventListener('focusin', focus); document.addEventListener('focusout', blur);
  document.addEventListener('pointerdown', away, true); addEventListener('scroll', away, true); addEventListener('blur', away);
  return {
    destroy() {
      tip.on = false; hideTip(); offEsc();
      document.removeEventListener('pointerup', tap);
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', away, true); removeEventListener('scroll', away, true); removeEventListener('blur', away);
    },
  };
}

// Context menu ------------------------------------------------------------------------------------------------------
// placeAt(el, x, y): a floating surface at a point (a context menu at the pointer), turned to stay in the viewport.
function placeAt(el, x, y) {
  const edge = px('--rk-space-m');
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, h = el.offsetHeight, vw = document.documentElement.clientWidth, vh = innerHeight;
  const left = x + w > vw - edge ? Math.max(edge, x - w) : x, top = y + h > vh - edge ? Math.max(edge, y - h) : y;
  el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
  el.dataset.rkSide = top < y ? 'above' : 'below';
}
// The keys of an open menu: ↑ ↓ wrap, Home End, letters jump (find, a typeAhead()); Escape and Tab close.
function menuKeys(e, list, close, find) {
  const i = list.indexOf(document.activeElement), go = (k) => { if (list.length) list[(k + list.length) % list.length].focus(); };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? -1 : i - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); } else if (e.key === 'End') { e.preventDefault(); go(-1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } else if (e.key === 'Tab') { e.preventDefault(); close(true); }
  else { const hit = find(e, list, list[i]); if (hit) { e.preventDefault(); hit.focus(); } }
}
// contextMenu(scope, el, { target, onOpen, onSelect }): a menu opened where the pointer is: a right click, a long
// press on touch (long-press), or Shift+F10 or the context-menu key on a focused target, then below it. target picks
// what has a menu inside scope; onOpen(target, event) prepares the menu for it (return false to leave the browser's
// own); onSelect(item, target) acts. Keys as in a menu; Escape or a choice returns focus to the target. A press
// outside, a resize, or a scroll that moves the target closes it; a scroll elsewhere (a strip gliding) does not.
export function contextMenu(scope, el, { target = '[tabindex], a, button', onOpen = null, onSelect = null } = {}) {
  el.id = el.id || uid('rk-context');
  el.setAttribute('role', 'menu');
  // Manual: the press that opens it has already happened, so the browser's light dismiss would close it at once.
  if (canPopover) el.setAttribute('popover', 'manual'); else el.hidden = true;
  el.classList.add('rk-float');
  let current = null, hold = 0, start = null, swallow = false, at = null;
  const items = () => [...el.querySelectorAll('.rk-menu-item')].filter((i) => i.getClientRects().length);
  function openAt(t, x, y, e) {
    if (onOpen && onOpen(t, e) === false) return false;
    current = t;
    openFloat(el); placeAt(el, x, y);
    at = t.getBoundingClientRect();
    const first = items().find((i) => i.getAttribute('aria-disabled') !== 'true') || items()[0];
    if (first) first.focus();
    return true;
  }
  function close(refocus = true) {
    if (!isOpen(el)) return;
    closeFloat(el);
    if (refocus && current && current.isConnected) { const f = current.matches('[tabindex], a, button, input') ? current : current.querySelector('[tabindex], a, button'); if (f) f.focus({ preventScroll: true }); }
  }
  const find = (n) => { const t = n && n.closest && n.closest(target); return t && scope.contains(t) ? t : null; };
  const atElement = (t) => { const r = t.getBoundingClientRect(); return [r.left + Math.min(24, r.width / 2), r.top + Math.min(r.height, 32)]; };
  const ctx = (e) => {
    const t = find(e.target);
    if (!t || (isOpen(el) && current === t && hold === -1)) { if (t) e.preventDefault(); return; }
    const r = t.getBoundingClientRect(), inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const [x, y] = inside ? [e.clientX, e.clientY] : atElement(t);
    if (openAt(t, x, y, e)) e.preventDefault();
  };
  const keydown = (e) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    const t = find(document.activeElement);
    if (!t) return;
    e.preventDefault();
    const [x, y] = atElement(t);
    openAt(t, x, y, e);
  };
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    const t = find(e.target);
    if (!t) return;
    start = { x: e.clientX, y: e.clientY, t };
    clearTimeout(hold);
    hold = setTimeout(() => { hold = -1; swallow = true; openAt(t, start.x, start.y, e); }, ms('--rk-duration-long-press') || 500);
  };
  const move = (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { clearTimeout(hold); hold = 0; start = null; } };
  const up = () => { if (hold > 0) clearTimeout(hold); hold = 0; start = null; };
  const click = (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } };
  const jump = typeAhead(), key = (e) => menuKeys(e, items(), close, jump);
  const choose = (e) => {
    const item = e.target.closest('.rk-menu-item');
    if (!item || item.getAttribute('aria-disabled') === 'true') { if (item) e.preventDefault(); return; }
    const t = current;
    close(true);
    if (onSelect) onSelect(item, t);
  };
  const outside = (e) => { if (isOpen(el) && !el.contains(e.target)) close(false); };
  el.addEventListener('focusout', (e) => { if (isOpen(el) && e.relatedTarget && !el.contains(e.relatedTarget)) close(false); });
  const away = (e) => { if (isOpen(el) && !(e.target instanceof Node && el.contains(e.target))) close(false); };
  // A scroll closes it only when what it was opened on moves: a strip gliding to its title elsewhere leaves it open.
  const scrolled = (e) => {
    if (!isOpen(el) || (e.target instanceof Node && el.contains(e.target))) return;
    const r = current && current.isConnected ? current.getBoundingClientRect() : null;
    if (!r || !at || Math.abs(r.left - at.left) > 2 || Math.abs(r.top - at.top) > 2) close(false);
  };
  scope.addEventListener('contextmenu', ctx);
  scope.addEventListener('keydown', keydown);
  scope.addEventListener('pointerdown', down);
  scope.addEventListener('pointermove', move);
  for (const ev of ['pointerup', 'pointercancel']) scope.addEventListener(ev, up);
  scope.addEventListener('click', click, true);
  el.addEventListener('keydown', key);
  el.addEventListener('click', choose);
  document.addEventListener('pointerdown', outside, true);
  addEventListener('scroll', scrolled, true); addEventListener('resize', away); addEventListener('blur', away);
  return {
    open(t) { const [x, y] = atElement(t); return openAt(t, x, y, null); },
    close,
    get target() { return current; },
    destroy() {
      scope.removeEventListener('contextmenu', ctx); scope.removeEventListener('keydown', keydown); scope.removeEventListener('pointerdown', down);
      scope.removeEventListener('pointermove', move); scope.removeEventListener('click', click, true);
      for (const ev of ['pointerup', 'pointercancel']) scope.removeEventListener(ev, up);
      el.removeEventListener('keydown', key); el.removeEventListener('click', choose);
      document.removeEventListener('pointerdown', outside, true); removeEventListener('scroll', scrolled, true); removeEventListener('resize', away); removeEventListener('blur', away);
    },
  };
}

// Tile grid --------------------------------------------------------------------------------------------------------
// grid(el): a grid of tiles that open (a.rk-tile, button.rk-tile in a .rk-tiles) is one tab stop, and the arrows move
// through it the way the eye does: ← → ↑ ↓ go to the nearest tile that way, one sharing the row or column first (on a
// tie the better-aligned one), and on into the grids of the panorama's other sections; at the edge focus stays. Home
// End go to the grid's first and last tile, letters jump (typeAhead: a tile's aria-label, else its words without its
// status word), Tab leaves. The tile last focused is the grid's tab stop. start() attaches it to every .rk-tiles that
// holds a tile that opens; a grid a framework renders later calls it itself. Returns { refresh, destroy }.
const OPENS = 'a.rk-tile, button.rk-tile';
const ARROWS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
const grids = new WeakMap();
const tileName = (t) => t.getAttribute('aria-label') || [...t.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('.rk-tile-word, [aria-hidden="true"]'))).map((n) => n.textContent).join(' ');
export function grid(el) {
  if (grids.has(el)) return grids.get(el);
  el.setAttribute('data-rk-grid', '');
  const shown = (t) => t.getClientRects().length > 0 && !t.closest('[hidden], [inert]');
  const own = () => [...el.querySelectorAll(OPENS)].filter((t) => t.closest('[data-rk-grid]') === el);
  // Every tile the arrows may reach: in this grid and, in a panorama, in its other sections' grids.
  const reach = () => [...(el.closest('.rk-panorama') || el).querySelectorAll(OPENS)].filter((t) => t.closest('[data-rk-grid]') && shown(t));
  let stop = null;
  function prepare() {
    const list = own();
    if (!list.includes(stop) || !shown(stop)) stop = list.find(shown) || list[0] || null;
    for (const t of list) t.tabIndex = t === stop ? 0 : -1;
  }
  // The nearest tile from `from` in the direction [dx, dy]: wholly that way, sharing the row (or column) before not,
  // then by the gap to it, then by how much of its row (column) it shares. One that shares none counts only while it
  // lies more that way than across (within 45°), so → reaches the next section's grid and ↓ at a grid's foot stays.
  function nearest(from, [dx, dy]) {
    const a = from.getBoundingClientRect();
    let best = null, bk = null;
    for (const t of reach()) {
      if (t === from) continue;
      const b = t.getBoundingClientRect();
      const gap = dx > 0 ? b.left - a.right : dx < 0 ? a.left - b.right : dy > 0 ? b.top - a.bottom : a.top - b.bottom;
      if (gap < -1) continue;
      const shared = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const mx = (b.left + b.right - a.left - a.right) / 2, my = (b.top + b.bottom - a.top - a.bottom) / 2;
      if (shared <= 0 && Math.abs(dx ? my : mx) > Math.abs(dx ? mx : my)) continue;
      const k = shared > 0 ? [0, gap, -shared] : [1, gap - 2 * shared, 0];
      if (!bk || k[0] < bk[0] || (k[0] === bk[0] && (k[1] < bk[1] - 1 || (Math.abs(k[1] - bk[1]) <= 1 && k[2] < bk[2])))) { best = t; bk = k; }
    }
    return best;
  }
  const find = typeAhead();
  const key = (e) => {
    const t = e.target;
    if (!t.matches || !t.matches(OPENS) || t.closest('[data-rk-grid]') !== el || e.ctrlKey || e.metaKey || e.altKey) return;
    let to;
    if (ARROWS[e.key]) to = nearest(t, ARROWS[e.key]);                       // none at the edge: focus stays
    else if (e.key === 'Home' || e.key === 'End') { const list = own().filter(shown); to = list[e.key === 'Home' ? 0 : list.length - 1]; }
    else if (!(to = find(e, reach(), t, tileName))) return;
    e.preventDefault();
    if (to && to !== t) to.focus();
  };
  const focusin = (e) => { const t = e.target; if (t.matches && t.matches(OPENS) && t.closest('[data-rk-grid]') === el) { stop = t; prepare(); } };
  let queued = 0;
  const mo = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; prepare(); }); });
  mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  el.addEventListener('keydown', key);
  el.addEventListener('focusin', focusin);
  prepare();
  const ctl = {
    refresh: prepare,
    destroy() {
      mo.disconnect(); cancelAnimationFrame(queued); grids.delete(el);
      el.removeEventListener('keydown', key); el.removeEventListener('focusin', focusin);
      el.removeAttribute('data-rk-grid');
      for (const t of own()) t.removeAttribute('tabindex');
    },
  };
  grids.set(el, ctl);
  return ctl;
}

// Tree -------------------------------------------------------------------------------------------------------------
// tree(el, { onShow, onToggle }): a hierarchy (ul.rk-tree of li, each its row first, then a ul of children). A click
// selects an item and shows it; the chevron or a double click opens and closes it. Keys: ↑ ↓, → opens or goes in,
// ← closes or goes up, Home End, Enter or Space shows, * opens the siblings, letters jump (typeAhead). One tab stop.
export function tree(el, { onShow = null, onToggle = null } = {}) {
  el.setAttribute('role', 'tree');
  function prepare(ul, level) {
    for (const li of ul.children) {
      if (li.tagName !== 'LI') continue;
      li.setAttribute('role', 'treeitem'); li.setAttribute('aria-level', String(level));
      li.style.setProperty('--_rk-level', String(level - 1));
      let row = li.firstElementChild;
      if (!row || row.tagName === 'UL') { row = document.createElement('span'); li.prepend(row); }
      row.classList.add('rk-tree-row');
      const sub = li.querySelector(':scope > ul');
      if (!row.querySelector(':scope > .rk-tree-twisty')) { const tw = document.createElement('span'); tw.className = 'rk-tree-twisty'; tw.setAttribute('aria-hidden', 'true'); row.prepend(tw); }
      if (sub) {
        sub.setAttribute('role', 'group');
        if (!li.hasAttribute('aria-expanded')) li.setAttribute('aria-expanded', 'false');
        sub.hidden = li.getAttribute('aria-expanded') !== 'true';
        prepare(sub, level + 1);
      } else li.removeAttribute('aria-expanded');
      if (!li.hasAttribute('aria-selected')) li.setAttribute('aria-selected', 'false');
      if (li.tabIndex !== 0) li.tabIndex = -1;
    }
  }
  prepare(el, 1);
  const all = () => [...el.querySelectorAll('[role=treeitem]')];
  const shownItems = () => all().filter((li) => !li.parentElement.closest('[role=group][hidden]'));
  const roving = (li) => { for (const x of all()) x.tabIndex = x === li ? 0 : -1; };
  roving(all().find((li) => li.getAttribute('aria-selected') === 'true') || all()[0]);
  const rowOf = (li) => li.querySelector(':scope > .rk-tree-row');
  const find = typeAhead();
  function expand(li, open) {
    const sub = li.querySelector(':scope > ul');
    if (!sub || (li.getAttribute('aria-expanded') === 'true') === open) return;
    li.setAttribute('aria-expanded', String(open));
    const d = ms('--rk-duration-short');
    sub.getAnimations().forEach((a) => a.cancel());
    if (!d) sub.hidden = !open;
    else if (open) {
      sub.hidden = false;
      const h = sub.offsetHeight;
      sub.animate([{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: `${h}px`, opacity: 1, overflow: 'hidden' }], { duration: d, easing: css('--rk-ease-in') });
    } else {
      const h = sub.offsetHeight;
      sub.animate([{ height: `${h}px`, opacity: 1, overflow: 'hidden' }, { height: '0px', opacity: 0, overflow: 'hidden' }], { duration: d * 0.7, easing: css('--rk-ease-out') })
        .finished.then(() => { if (li.getAttribute('aria-expanded') === 'false') sub.hidden = true; }, () => {});
    }
    if (onToggle) onToggle(li, open);
  }
  function choose(li, show = true) {
    for (const x of all()) x.setAttribute('aria-selected', String(x === li));
    roving(li);
    if (show && onShow) onShow(li);
  }
  const click = (e) => {
    const row = e.target.closest('.rk-tree-row'), li = row && row.parentElement;
    if (!li || !el.contains(li)) return;
    if (e.target.closest('a[href]')) e.preventDefault();
    if (e.target.closest('.rk-tree-twisty') && li.hasAttribute('aria-expanded')) { expand(li, li.getAttribute('aria-expanded') !== 'true'); roving(li); li.focus({ preventScroll: true }); return; }
    choose(li); li.focus({ preventScroll: true });
  };
  const dbl = (e) => { const row = e.target.closest('.rk-tree-row'), li = row && row.parentElement; if (li && li.hasAttribute('aria-expanded') && !e.target.closest('.rk-tree-twisty')) expand(li, li.getAttribute('aria-expanded') !== 'true'); };
  const key = (e) => {
    const li = e.target.closest('[role=treeitem]');
    if (!li || e.target !== li || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = shownItems(), i = list.indexOf(li), go = (x) => { if (x) { roving(x); x.focus(); } };
    const open = li.getAttribute('aria-expanded');
    if (e.key === 'ArrowDown') go(list[i + 1]);
    else if (e.key === 'ArrowUp') go(list[i - 1]);
    else if (e.key === 'Home') go(list[0]);
    else if (e.key === 'End') go(list[list.length - 1]);
    else if (e.key === 'ArrowRight') { if (open === 'false') expand(li, true); else if (open === 'true') go(li.querySelector(':scope > ul > li')); else return; }
    else if (e.key === 'ArrowLeft') { if (open === 'true') expand(li, false); else go(li.parentElement.closest('[role=treeitem]')); }
    else if (e.key === 'Enter' || e.key === ' ') choose(li);
    else if (e.key === '*') [...li.parentElement.children].forEach((x) => expand(x, true));
    else { const hit = find(e, list, li, (x) => rowOf(x).textContent); if (!hit) return; go(hit); }
    e.preventDefault();
  };
  el.addEventListener('click', click); el.addEventListener('dblclick', dbl); el.addEventListener('keydown', key);
  return {
    expand, select: choose,
    expandAll(open = true) { all().forEach((li) => expand(li, open)); },
    selected: () => all().find((li) => li.getAttribute('aria-selected') === 'true') || null,
    refresh() { prepare(el, 1); },
    destroy() { el.removeEventListener('click', click); el.removeEventListener('dblclick', dbl); el.removeEventListener('keydown', key); },
  };
}

// Sortable ---------------------------------------------------------------------------------------------------------
// sortable(list, { items, handle, onMove }): items reordered by dragging their grip (.rk-grip, a button): the item
// lifts as a floating surface, the others make room, and on release everything settles (FLIP). Keys on the grip:
// Space or Enter picks the item up, ↑ ↓ move it, Space or Enter puts it down, Escape puts it back; Alt+↑ ↓ moves it
// at once. Each move is said in a live region. onMove(from, to, item) after a move.
export function sortable(list, { items = ':scope > li', handle = '.rk-grip', onMove = null } = {}) {
  const all = () => [...list.querySelectorAll(items)];
  const itemOf = (n) => all().find((it) => it.contains(n)) || null;
  const live = document.createElement('span');
  live.className = 'rk-sr'; live.setAttribute('role', 'status');
  list.after(live);
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
  const name = (it) => (it.querySelector('b, a, span:not(.rk-grip)') || it).textContent.trim();
  let drag = null, grabbed = null, moving = false;
  function flip(change) {
    const els = all(), before = new Map(els.map((x) => [x, x.getBoundingClientRect().top]));
    change();
    const d = ms('--rk-duration-moderate');
    if (!d) return;
    for (const x of els) { const dy = before.get(x) - x.getBoundingClientRect().top; if (dy) x.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: d, easing: css('--rk-ease-base') }); }
  }
  function moveTo(item, to) {
    const els = all(), from = els.indexOf(item);
    if (to === from || to < 0 || to >= els.length) return false;
    const grip = item.querySelector(handle), had = grip && document.activeElement === grip;
    moving = true;                                                     // moving the node blurs it for a moment
    flip(() => { const rest = els.filter((x) => x !== item); if (to >= rest.length) rest[rest.length - 1].after(item); else rest[to].before(item); });
    if (had) grip.focus({ preventScroll: true });
    moving = false;
    if (onMove) onMove(from, to, item);
    return true;
  }
  const down = (e) => {
    const grip = e.target.closest(handle), item = grip && itemOf(grip);
    if (!item || e.button !== 0 || grabbed) return;
    e.preventDefault();
    const els = all();
    drag = { item, grip, id: e.pointerId, y: e.clientY, from: els.indexOf(item), to: els.indexOf(item), rects: els.map((x) => x.getBoundingClientRect()), els, moved: false };
    grip.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved) { if (Math.abs(dy) < 4) return; drag.moved = true; drag.item.setAttribute('data-rk-dragging', ''); list.setAttribute('data-rk-sorting', ''); }
    drag.item.style.transform = `translateY(${dy}px)`;
    const r = drag.rects[drag.from], mid = r.top + r.height / 2 + dy, h = r.height + (drag.rects[1] ? Math.max(0, drag.rects[1].top - drag.rects[0].bottom) : 0);
    let to = drag.from;
    drag.rects.forEach((x, i) => { const m = x.top + x.height / 2; if (i > drag.from && mid > m) to = i; if (i < drag.from && mid < m && to === drag.from) to = i; });
    if (to < drag.from) { const first = drag.rects.findIndex((x, i) => i < drag.from && mid < x.top + x.height / 2); to = first; }
    drag.to = to;
    drag.els.forEach((x, i) => { if (x === drag.item) return; const shift = drag.from < to && i > drag.from && i <= to ? -h : drag.from > to && i >= to && i < drag.from ? h : 0; x.style.transform = shift ? `translateY(${shift}px)` : ''; });
  };
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { item, from, to, moved, els } = drag, cancel = e.type === 'pointercancel';
    drag = null;
    if (!moved) return;
    const before = new Map(els.map((x) => [x, x.getBoundingClientRect().top]));
    els.forEach((x) => { x.style.transform = ''; });
    item.removeAttribute('data-rk-dragging'); list.removeAttribute('data-rk-sorting');
    if (!cancel && to !== from) { const rest = els.filter((x) => x !== item); if (to >= rest.length) rest[rest.length - 1].after(item); else rest[to].before(item); }
    const d = ms('--rk-duration-moderate');
    if (d) for (const x of els) { const dy = before.get(x) - x.getBoundingClientRect().top; if (dy) x.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: d, easing: css('--rk-ease-base') }); }
    if (!cancel && to !== from) { if (onMove) onMove(from, to, item); say(tx('position', name(item), to + 1, els.length)); }
  };
  const key = (e) => {
    const grip = e.target.closest(handle), item = grip && itemOf(grip);
    if (!item) return;
    const els = all(), i = els.indexOf(item);
    if (grabbed === item) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); if (moveTo(item, i + (e.key === 'ArrowUp' ? -1 : 1))) say(tx('position', '', all().indexOf(item) + 1, els.length)); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); grabbed.removeAttribute('data-rk-grabbed'); grip.setAttribute('aria-pressed', 'false'); grabbed = null; say(tx('putDown', name(item), i + 1, els.length)); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); moveTo(item, +item.dataset.rkFrom); item.removeAttribute('data-rk-grabbed'); grip.setAttribute('aria-pressed', 'false'); grabbed = null; say(tx('putBack', name(item))); }
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); if (moveTo(item, i + (e.key === 'ArrowUp' ? -1 : 1))) say(tx('position', name(item), all().indexOf(item) + 1, els.length)); return; }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); grabbed = item; item.dataset.rkFrom = String(i); item.setAttribute('data-rk-grabbed', ''); grip.setAttribute('aria-pressed', 'true');
      say(tx('pickedUp', name(item), i + 1, els.length));
    }
  };
  const blur = (e) => { if (grabbed && !moving && !grabbed.contains(e.relatedTarget)) { grabbed.removeAttribute('data-rk-grabbed'); const g = grabbed.querySelector(handle); if (g) g.setAttribute('aria-pressed', 'false'); grabbed = null; } };
  function prepare() { for (const it of all()) { const g = it.querySelector(handle); if (g) { g.setAttribute('aria-pressed', 'false'); if (!g.getAttribute('aria-label')) g.setAttribute('aria-label', tx('move', name(it))); } } }
  prepare();
  list.addEventListener('pointerdown', down); list.addEventListener('pointermove', move);
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
  list.addEventListener('keydown', key); list.addEventListener('focusout', blur);
  return {
    move: moveTo, refresh: prepare,
    destroy() {
      list.removeEventListener('pointerdown', down); list.removeEventListener('pointermove', move); list.removeEventListener('pointerup', end);
      list.removeEventListener('pointercancel', end); list.removeEventListener('keydown', key); list.removeEventListener('focusout', blur); live.remove();
    },
  };
}

// Removable ----------------------------------------------------------------------------------------------------------
// removable(list, { items, onRemove }): entries a person may remove, each removal reversible (docs/collections.md).
// Three ways, all calling onRemove(item, { left }): a button marked data-rk-remove inside the entry; Delete (or ⌫,
// outside a text field) on the entry focus is in, after which focus moves to the next entry, or the one before at the
// end; and dragging the entry towards its trailing edge, a shortcut beside the other two. Dragged, the entry follows
// the pointer sideways; let go past half its width it leaves that way (left: true: it has gone from sight, so remove it
// at once, with no leave() of its own), else it glides back. A drag starts only sideways and never from the window's
// edges, where a phone's back gesture begins; a click that ends one is cancelled, so dragging never activates.
export function removable(list, { items = ':scope > li, :scope > tr', onRemove = () => {} } = {}) {
  const entries = () => [...list.querySelectorAll(items)].filter((x) => !x.hidden);
  const entryOf = (t) => { const x = t && t.closest && t.closest(items.split(',').map((s) => s.trim().replace(/^:scope > /, '')).join(', ')); return x && list.contains(x) && entries().includes(x) ? x : null; };
  const away = () => (getComputedStyle(list).direction === 'rtl' ? -1 : 1);
  const focusable = (x) => (x.matches('[tabindex], a[href], button') ? x : x.querySelector('[tabindex]:not([tabindex="-1"]), a[href], button:not([data-rk-remove])') || x);
  function remove(item, left) {
    const all = entries(), i = all.indexOf(item), next = all[i + 1] || all[i - 1] || null;
    const hadFocus = item.contains(document.activeElement);
    onRemove(item, { left });
    if (hadFocus && next && next.isConnected) { const f = focusable(next); if (f.tabIndex < 0 && !f.hasAttribute('tabindex')) f.tabIndex = -1; f.focus(); }
  }
  const click = (e) => {
    const b = e.target.closest && e.target.closest('[data-rk-remove]'), item = b && entryOf(b);
    if (item) { e.preventDefault(); remove(item, false); }
  };
  const key = (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    const item = entryOf(e.target);
    if (!item) return;
    e.preventDefault(); remove(item, false);
  };
  let drag = null, swallow = false;
  const down = (e) => {
    if (e.button !== 0 || drag) return;
    const item = entryOf(e.target);
    if (!item || e.target.closest('a, button, input, select, textarea, label, .rk-grip, [data-rk-remove]')) return;
    const edge = px('--rk-space-l');
    if (e.pointerType !== 'mouse' && (e.clientX < edge || e.clientX > innerWidth - edge)) return;
    drag = { item, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; }      // a scroll, not a drag
      if (dx * away() < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      drag.on = true;
      try { list.setPointerCapture(e.pointerId); } catch { /* the pointer has gone */ }
      for (const a of drag.item.getAnimations()) a.cancel();
    }
    drag.dx = Math.max(0, dx * away()) * away();
    drag.item.style.transform = `translateX(${drag.dx}px)`;
  };
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { item, dx, on } = drag;
    drag = null;
    if (!on) return;
    swallow = true; setTimeout(() => { swallow = false; });
    const w = item.getBoundingClientRect().width, gone = e.type === 'pointerup' && Math.abs(dx) > w / 2;
    item.style.transform = '';
    const from = `translateX(${dx}px)`;
    if (gone) {
      const d = ms('--rk-duration-short') * 0.6;
      if (d) item.animate([{ transform: from, opacity: 1 }, { transform: `translateX(${away() * w}px)`, opacity: 0 }], { duration: d, easing: css('--rk-ease-out'), fill: 'forwards' }).finished.then(() => remove(item, true), () => {});
      else { item.style.opacity = '0'; remove(item, true); }
    } else {
      const d = ms('--rk-duration-short');
      if (d) item.animate([{ transform: from }, { transform: 'none' }], { duration: d, easing: css('--rk-ease-base') });
    }
  };
  const stopClick = (e) => { if (swallow) { e.preventDefault(); e.stopImmediatePropagation(); swallow = false; } };
  list.setAttribute('data-rk-removable', '');
  list.addEventListener('click', click); list.addEventListener('keydown', key);
  list.addEventListener('pointerdown', down); list.addEventListener('pointermove', move);
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
  list.addEventListener('click', stopClick, true);
  return {
    remove: (item) => remove(item, false),
    destroy() {
      list.removeAttribute('data-rk-removable');
      list.removeEventListener('click', click); list.removeEventListener('keydown', key);
      list.removeEventListener('pointerdown', down); list.removeEventListener('pointermove', move);
      list.removeEventListener('pointerup', end); list.removeEventListener('pointercancel', end);
      list.removeEventListener('click', stopClick, true);
    },
  };
}

// Virtual list -----------------------------------------------------------------------------------------------------
// virtual(el, { count, render, onShow, onChange, appbar, label }): a list of any length in a .rk-virtual scroller
// with a bounded height. Only the rows in view (and a few more) exist; render(i, row) fills a row. It is one tab stop
// (a listbox; the active row by aria-activedescendant) chosen the Metro way like select(): a click selects and shows,
// Ctrl/Cmd+click starts the selection mode, Shift takes a range, Ctrl/Cmd+A all, Escape ends the mode. ↑ ↓ PageUp
// PageDown Home End move, and letters jump (typeAhead) by text(i), an item's words; without it, by the text render()
// writes into a row that is not shown (once per item, until refresh()). The row height is the density's.
export function virtual(el, { count = 0, render, text = null, onShow = null, onChange = null, appbar = null, label = '' } = {}) {
  const id = uid('rk-virtual');
  el.setAttribute('role', 'listbox'); el.setAttribute('aria-multiselectable', 'true'); el.tabIndex = 0;
  if (label) el.setAttribute('aria-label', label);
  const body = document.createElement('div');
  body.className = 'rk-virtual-body';
  el.replaceChildren(body);
  let n = count, h = 0, first = 0, last = 0, active = -1, anchor = -1, mode = false, frame = 0;
  const sel = new Set(), find = typeAhead(), words = new Map();
  const textAt = (i) => {
    if (text) return text(i);
    if (!words.has(i)) { const row = document.createElement('div'); render(i, row); words.set(i, row.textContent); }
    return words.get(i);
  };
  function paint(force = false) {
    frame = 0;
    h = px('--rk-row-height') || 44;
    body.style.height = `${n * h}px`;
    const top = el.scrollTop, vh = el.clientHeight || 400, over = 6;
    const a = Math.max(0, Math.floor(top / h) - over), b = Math.min(n, Math.ceil((top + vh) / h) + over);
    if (force || a !== first || b !== last) {
      const rows = [];
      for (let i = a; i < b; i++) {
        const row = document.createElement('div');
        row.className = 'rk-virtual-row'; row.id = `${id}-${i}`; row.dataset.index = String(i);
        row.setAttribute('role', 'option'); row.setAttribute('aria-posinset', String(i + 1)); row.setAttribute('aria-setsize', String(n));
        row.setAttribute('data-rk-press', '');
        row.style.top = `${i * h}px`;
        render(i, row);
        rows.push(row);
      }
      body.replaceChildren(...rows);
      first = a; last = b;
    }
    mark();
  }
  function mark() {
    for (const row of body.children) {
      const i = +row.dataset.index;
      row.setAttribute('aria-selected', String(sel.has(i)));
      row.toggleAttribute('data-rk-active', i === active);
    }
    if (active >= first && active < last) el.setAttribute('aria-activedescendant', `${id}-${active}`); else el.removeAttribute('aria-activedescendant');
  }
  const queue = () => { if (!frame) frame = requestAnimationFrame(() => paint()); };
  function sync() {
    if (!sel.size) mode = false;
    el.toggleAttribute('data-rk-selecting', mode);
    if (appbar) selectionMode(appbar, el, mode, sel.size);
    mark();
    const list = [...sel].sort((x, y) => x - y);
    if (onChange) onChange(list, { mode });
    el.dispatchEvent(new CustomEvent('rk:selectionchange', { bubbles: true, detail: { count: sel.size, mode, indices: list } }));
  }
  function reveal(i) {
    const top = i * h, bottom = top + h;
    if (top < el.scrollTop) el.scrollTop = top; else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    paint();
  }
  function only(i, { show = true } = {}) { mode = false; sel.clear(); if (i >= 0) sel.add(i); active = anchor = i; sync(); if (show && i >= 0 && onShow) onShow(i); }
  function toggle(i) { mode = true; if (sel.has(i)) sel.delete(i); else sel.add(i); active = anchor = i; sync(); }
  function range(i, add) { const a = anchor < 0 ? i : anchor; if (!add) sel.clear(); for (let k = Math.min(a, i); k <= Math.max(a, i); k++) sel.add(k); mode = sel.size > 1; active = i; sync(); }
  function act(i, { add = false, extend = false } = {}) { if (extend) range(i, add || mode); else if (add || mode) toggle(i); else only(i); }
  const click = (e) => {
    const row = e.target.closest('.rk-virtual-row');
    if (!row || e.button !== 0) return;
    act(+row.dataset.index, { add: e.ctrlKey || e.metaKey, extend: e.shiftKey });
    el.focus({ preventScroll: true });
  };
  const key = (e) => {
    if (e.target !== el || e.altKey) return;
    const page = Math.max(1, Math.floor(el.clientHeight / h) - 1);
    const to = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + page, PageUp: active - page, Home: 0, End: n - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const i = Math.max(0, Math.min(n - 1, active < 0 ? 0 : to));
      if (e.shiftKey) range(i, mode); else { active = i; mark(); }
      reveal(i);
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && active >= 0) { e.preventDefault(); act(active, { add: e.ctrlKey || e.metaKey, extend: e.shiftKey }); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); mode = true; for (let i = 0; i < n; i++) sel.add(i); sync(); }
    else {
      const hit = find(e, Array.from({ length: n }, (_, i) => i), active, textAt);
      if (hit !== null) { e.preventDefault(); active = hit; mark(); reveal(hit); }
    }
  };
  const focus = () => { if (active < 0 && n) { active = Math.min(n - 1, Math.floor(el.scrollTop / (h || 1))); mark(); } };
  const offEsc = keys.on(20, (e) => {
    if (e.key !== 'Escape' || !mode || (!el.contains(e.target) && !(appbar && appbar.contains(e.target)))) return false;
    sel.clear(); sync(); return true;
  });
  const clearClick = (e) => { if (e.target.closest('[data-rk-clear]') && mode) { sel.clear(); sync(); } };
  const ro = new ResizeObserver(() => paint(true));
  ro.observe(el);
  const dens = () => paint(true);
  el.addEventListener('scroll', queue, { passive: true });
  el.addEventListener('click', click); el.addEventListener('keydown', key); el.addEventListener('focus', focus);
  document.addEventListener('rk:prefs', dens);
  if (appbar) appbar.addEventListener('click', clearClick);
  paint(true);
  return {
    refresh(count = n) { n = count; words.clear(); for (const i of [...sel]) if (i >= n) sel.delete(i); if (active >= n) active = n - 1; paint(true); sync(); },
    scrollTo(i) { active = i; reveal(i); },
    selected: () => [...sel].sort((x, y) => x - y),
    only, clear() { sel.clear(); sync(); },
    get mode() { return mode; },
    get count() { return n; },
    destroy() {
      ro.disconnect(); offEsc(); el.removeEventListener('scroll', queue); el.removeEventListener('click', click); el.removeEventListener('keydown', key);
      el.removeEventListener('focus', focus); document.removeEventListener('rk:prefs', dens);
      if (appbar) { appbar.removeEventListener('click', clearClick); selectionMode(appbar, el, false, 0); }
    },
  };
}

// Undo history -----------------------------------------------------------------------------------------------------
// undoStack({ toaster, limit }): actions that can be taken back. do({ label, run, undo, redo }) runs and remembers one;
// its toast offers undo. Ctrl/Cmd+Z undoes the last (outside text fields), Ctrl/Cmd+Shift+Z or Ctrl+Y redoes; an undo's
// toast offers redo. entries() lists them for a history view. rk:historychange on document after each change.
export function undoStack({ toaster: toasts = null, limit = 50 } = {}) {
  const done = [], undone = [];
  const fire = () => document.dispatchEvent(new CustomEvent('rk:historychange', { detail: { undo: done.length ? done[done.length - 1].label : null, redo: undone.length ? undone[undone.length - 1].label : null } }));
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  async function doIt({ label, run, undo, redo = run }) {
    await run();
    done.push({ label, undo, redo, at: Date.now() });
    if (done.length > limit) done.shift();
    undone.length = 0;
    if (toasts) toasts.show(label, { key: `rk-history-${label}`, undo: () => undoIt() });
    fire();
  }
  async function undoIt() {
    const e = done.pop();
    if (!e) { if (toasts) toasts.show(tx('nothingToUndo'), { key: 'rk-history-none' }); return false; }
    await e.undo();
    undone.push(e);
    if (toasts) toasts.show(tx('undone', lower(e.label)), { key: `rk-history-undone-${e.label}`, undo: () => redoIt(), action: 'redo' });
    fire();
    return true;
  }
  async function redoIt() {
    const e = undone.pop();
    if (!e) return false;
    await e.redo();
    done.push(e);
    if (toasts) toasts.show(e.label, { key: `rk-history-${e.label}`, undo: () => undoIt() });
    fire();
    return true;
  }
  const off = keys.on(4, (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isEditable(e.target)) return false;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { if (!done.length) return false; undoIt(); return true; }
    if ((k === 'z' && e.shiftKey) || (k === 'y' && !isMac)) { if (!undone.length) return false; redoIt(); return true; }
    return false;
  });
  return {
    do: doIt, undo: undoIt, redo: redoIt,
    get canUndo() { return done.length > 0; },
    get canRedo() { return undone.length > 0; },
    entries: () => [...done.map((e) => ({ label: e.label, at: e.at, done: true })), ...undone.slice().reverse().map((e) => ({ label: e.label, at: e.at, done: false }))],
    clear() { done.length = 0; undone.length = 0; fire(); },
    destroy() { off(); },
  };
}

// Live contract ----------------------------------------------------------------------------------------------------
// live(region, { stale, age, hold }): a region of live values keeps its promise. It says how fresh it is (.rk-age:
// "updated 4 s ago"); with no update or heartbeat for stale (timing.stale) it is stale, and offline when told, and
// says that too (data-rk-live = fresh | stale | offline). While the pointer rests on it or focus is in it, it holds
// still (data-rk-held): updates wait, a button says how many, and they apply when it is let go or the button is
// pressed. update(apply, key) applies or queues one (the same key replaces a waiting one); beat() is a heartbeat
// without a change.
export function live(region, { stale = 0, age = region.querySelector('.rk-age'), hold = true } = {}) {
  let last = Date.now(), held = false, offline = false, waiting = [];
  const limit = () => stale || ms('--rk-duration-stale') || 30000;
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'rk-btn rk-btn--quiet rk-live-more'; more.hidden = true;
  (age || region).after(more);
  const ago = (d) => { const s = Math.round(d / 1000); return s < 5 ? tx('justNow') : s < 60 ? tx('secondsAgo', s) : s < 3600 ? tx('minutesAgo', Math.floor(s / 60)) : tx('at', clock(new Date(Date.now() - d))); };
  const staleFor = (d) => { const s = Math.round(d / 1000); return tx('staleFor', s, Math.floor(s / 60), clock(new Date(Date.now() - d))); };
  const state = () => (offline ? 'offline' : Date.now() - last > limit() ? 'stale' : 'fresh');
  function paint() {
    const s = state(), since = Date.now() - last;
    if (region.dataset.rkLive !== s) region.dataset.rkLive = s;
    if (age) age.textContent = s === 'offline' ? tx('offlineSince', ago(since)) : s === 'stale' ? staleFor(since) : held ? tx('heldUpdated', ago(since)) : tx('updated', ago(since));
    more.hidden = !waiting.length;
    more.textContent = tx('updatesWaiting', waiting.length);
  }
  function flush() { const list = waiting; waiting = []; list.forEach((w) => w.apply()); paint(); }
  function update(apply, key = null) {
    last = Date.now();
    if (held && hold) { if (key) waiting = waiting.filter((w) => w.key !== key); waiting.push({ apply, key }); } else apply();
    paint();
  }
  const setHeld = (v) => { if (held === v) return; held = v; region.toggleAttribute('data-rk-held', v); if (!v) flush(); else paint(); };
  let pointer = false, focusIn = false;
  const enter = (e) => { if (e.pointerType !== 'touch') { pointer = true; setHeld(true); } };
  const leave = (e) => { if (e.pointerType !== 'touch') { pointer = false; setHeld(focusIn); } };
  const fin = () => { focusIn = true; setHeld(true); };
  const fout = (e) => { if (!region.contains(e.relatedTarget) && e.relatedTarget !== more) { focusIn = false; setHeld(pointer); } };
  const tick = setInterval(paint, 1000);
  if (hold) { region.addEventListener('pointerenter', enter); region.addEventListener('pointerleave', leave); region.addEventListener('focusin', fin); region.addEventListener('focusout', fout); }
  more.addEventListener('click', flush);
  paint();
  return {
    update, flush,
    beat() { last = Date.now(); paint(); },
    offline(v = true) { offline = v; if (!v) last = Date.now(); paint(); },
    get state() { return state(); },
    get held() { return held; },
    get waiting() { return waiting.length; },
    destroy() {
      clearInterval(tick); more.remove();
      region.removeEventListener('pointerenter', enter); region.removeEventListener('pointerleave', leave); region.removeEventListener('focusin', fin); region.removeEventListener('focusout', fout);
    },
  };
}

// Charts -----------------------------------------------------------------------------------------------------------
// chart(el, { type, labels, series, unit, min, max, height, summary, table }): a line or bar chart in ink and grey,
// drawn as SVG at the element's width and redrawn when it changes. series is [{ label, values }]: the first is ink
// (text-primary), a second grey (text-contrast-medium); the accent marks only the point under the pointer. One axis,
// hairline gridlines at round ticks, 2px lines, bars at most 24px wide with 2px between them, square ends. Two series
// get a legend; lines get labels at their ends when they do not collide. Hover or ←→ on the focused chart shows every
// value at that point in a tooltip (and to screen readers); a table of the same numbers follows it. Lines draw in and
// bars grow from the baseline once, when first drawn.
const SVGNS = 'http://www.w3.org/2000/svg';
// A series in a product's domain colour code (series.code: 1 to 8, --rk-series-N; docs/data.md).
const code = (s) => (s.code ? { 'data-rk-code': String(Math.max(1, Math.min(8, Math.round(+s.code) || 1))) } : {});
const svgEl = (tag, attrs = {}, parent = null) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
function niceTicks(lo, hi, count = 4) {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}
const compact = (v) => number(v);
export function chart(el, opts = {}) {
  let o = { type: 'line', labels: [], series: [], unit: '', min: undefined, max: undefined, height: 220, summary: '', table: true, ...opts };
  el.classList.add('rk-chart');
  const legend = document.createElement('ul'); legend.className = 'rk-legend';
  const svg = svgEl('svg', { role: 'img', tabindex: '0', class: 'rk-chart-svg' });
  const say = document.createElement('span'); say.className = 'rk-sr'; say.setAttribute('role', 'status');
  const details = document.createElement('details'); details.className = 'rk-chart-table';
  el.replaceChildren(legend, svg, say, details);
  let drawn = false, active = -1, geo = null;
  const fmt = (v) => `${compact(v)}${o.unit}`;
  function draw() {
    const W = Math.max(240, el.clientWidth), H = o.height, n = o.labels.length, bars = o.type === 'bars';
    const all = o.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    const ticks = niceTicks(o.min !== undefined ? o.min : bars ? 0 : Math.min(...all), o.max !== undefined ? o.max : Math.max(...all));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const charW = (px('--rk-font-size-xs') || 12) * 0.62;
    const ends = !bars && o.series.length <= 4 && (W >= 480 || o.series.length < 2);
    const left = Math.ceil(Math.max(...ticks.map((t) => fmt(t).length)) * charW) + 10;
    const right = ends ? Math.ceil(Math.max(...o.series.map((s) => s.label.length)) * charW) + 14 : 8;
    const top = 8, bottom = 24, pw = W - left - right, ph = H - top - bottom;
    const y = (v) => top + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const band = pw / Math.max(1, n), x = (i) => (bars ? left + band * (i + 0.5) : left + (n > 1 ? (pw * i) / (n - 1) : pw / 2));
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('aria-label', o.summary || tx('chartName', o.type, o.series.map((s) => s.label), o.labels[0], o.labels[n - 1]));
    const grid = svgEl('g', { class: 'rk-chart-grid' }, svg);
    for (const t of ticks) {
      svgEl('line', { x1: left, x2: W - right, y1: y(t), y2: y(t) }, grid);
      svgEl('text', { x: left - 8, y: y(t), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid).textContent = fmt(t);
    }
    const every = Math.max(1, Math.ceil((n * (Math.max(...o.labels.map((l) => String(l).length)) * charW + 12)) / pw));
    const shown = o.labels.map((_, i) => i).filter((i) => i % every === 0);
    if (n > 1 && shown[shown.length - 1] !== n - 1) { if (n - 1 - shown[shown.length - 1] < every) shown.pop(); shown.push(n - 1); }
    o.labels.forEach((l, i) => { if (shown.includes(i)) svgEl('text', { x: x(i), y: H - 6, 'text-anchor': bars ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'rk-chart-x' }, grid).textContent = l; });
    const marks = svgEl('g', { class: 'rk-chart-marks' }, svg);
    const motion = !drawn && ms('--rk-duration-long') > 0;
    if (bars) {
      const k = o.series.length, w = Math.max(2, Math.min(24, (band - 4) / k - 2)), y0 = y(Math.max(lo, 0));
      let peak = { v: -Infinity };
      o.series.forEach((s, si) => s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const bx = x(i) - (k * w + (k - 1) * 2) / 2 + si * (w + 2), by = Math.min(y(v), y0), bh = Math.max(1, Math.abs(y0 - y(v)));
        const r = svgEl('rect', { x: bx, y: by, width: w, height: bh, class: `rk-bar rk-s${si}`, 'data-i': i, ...code(s) }, marks);
        if (motion) { r.setAttribute('data-rk-grow', ''); r.style.cssText = `animation-delay:${Math.min(i, 10) * ms('--rk-duration-stagger')}ms`; }
        if (si === 0 && v > peak.v) peak = { v, x: bx + w / 2, y: by, i };
      }));
      if (Number.isFinite(peak.v)) svgEl('text', { x: peak.x, y: peak.y - 6, 'text-anchor': 'middle', class: 'rk-chart-value' }, marks).textContent = fmt(peak.v);
    } else {
      const endYs = [];
      o.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null));
        const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}` : acc), '');
        svgEl('path', { d, class: `rk-line rk-s${si}`, pathLength: '1', ...code(s), ...(motion ? { 'data-rk-draw': '' } : {}) }, marks);
        const lastI = s.values.length - 1;
        if (Number.isFinite(s.values[lastI])) endYs.push({ si, y: y(s.values[lastI]), label: s.label });
      });
      const clash = endYs.some((a, i) => endYs.some((b, j) => j > i && Math.abs(a.y - b.y) < 14));
      if (ends && !clash) endYs.forEach((e) => { svgEl('text', { x: W - right + 6, y: e.y, 'dominant-baseline': 'middle', class: `rk-chart-end rk-t${e.si}` }, marks).textContent = e.label; });
    }
    const hot = svgEl('g', { class: 'rk-chart-hot', 'aria-hidden': 'true' }, svg);
    geo = { x, y, n, band, left, right, W, top, ph, bars, hot };
    svgEl('rect', { x: left, y: top, width: pw, height: ph, class: 'rk-chart-hit' }, svg);
    legend.hidden = o.series.length < 2;
    legend.replaceChildren(...o.series.map((s, si) => { const li = document.createElement('li'); li.innerHTML = `<i class="rk-key-${bars ? 'box' : 'line'} rk-s${si}"${s.code ? ` data-rk-code="${+s.code}"` : ''}></i>`; li.append(s.label); return li; }));
    if (o.table) {
      details.hidden = false;
      details.innerHTML = '<summary></summary><table class="rk-table"><thead><tr><th scope="col"></th></tr></thead><tbody></tbody></table>';
      details.querySelector('summary').textContent = tx('chartNumbers');
      const hr = details.querySelector('thead tr'), body = details.querySelector('tbody');
      o.series.forEach((s) => { const th = document.createElement('th'); th.scope = 'col'; th.className = 'rk-num'; th.textContent = s.label; hr.appendChild(th); });
      o.labels.forEach((l, i) => { const tr = document.createElement('tr'); const th = document.createElement('th'); th.scope = 'row'; th.textContent = l; tr.appendChild(th); o.series.forEach((s) => { const td = document.createElement('td'); td.className = 'rk-num'; td.textContent = Number.isFinite(s.values[i]) ? fmt(s.values[i]) : '–'; tr.appendChild(td); }); body.appendChild(tr); });
    } else details.hidden = true;
    drawn = true;
    if (active >= 0) mark(Math.min(active, n - 1), false);
  }
  function mark(i, speak = true) {
    if (!geo) return;
    active = i;
    const { x, y, hot, top, ph, bars } = geo;
    hot.replaceChildren();
    svg.toggleAttribute('data-rk-hovering', i >= 0);
    svg.querySelectorAll('[data-rk-hot]').forEach((b) => b.removeAttribute('data-rk-hot'));
    if (i < 0) { hideTip(); return; }
    let anchor;
    if (bars) { svg.querySelectorAll(`.rk-bar[data-i="${i}"]`).forEach((b) => b.setAttribute('data-rk-hot', '')); anchor = svg.querySelector(`.rk-bar[data-i="${i}"]`); }
    else {
      anchor = svgEl('line', { x1: x(i), x2: x(i), y1: top, y2: top + ph, class: 'rk-chart-cross' }, hot);
      o.series.forEach((s, si) => { if (Number.isFinite(s.values[i])) svgEl('circle', { cx: x(i), cy: y(s.values[i]), r: 4, class: `rk-chart-dot rk-s${si}`, ...code(s) }, hot); });
    }
    const text = `${o.labels[i]} · ${o.series.map((s) => `${o.series.length > 1 ? `${s.label} ` : ''}${Number.isFinite(s.values[i]) ? fmt(s.values[i]) : tx('noValue')}`).join(' · ')}`;
    if (anchor) showTip(anchor, text);
    if (speak) say.textContent = text;
  }
  const at = (e) => { if (!geo) return -1; const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * (geo.W / r.width), { n, left, bars, band } = geo; const pw = geo.W - left - geo.right; const i = bars ? Math.floor((sx - left) / band) : Math.round(((sx - left) / (pw || 1)) * (n - 1)); return i >= 0 && i < n ? i : -1; };
  const move = (e) => { if (e.pointerType === 'touch' && e.type === 'pointermove' && !e.pressure) return; const i = at(e); if (i !== active) mark(i, false); };
  const leave = () => { if (document.activeElement !== svg) mark(-1); };
  const key = (e) => {
    const n = geo ? geo.n : 0, to = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault(); mark(Math.max(0, Math.min(n - 1, active < 0 ? (e.key === 'ArrowLeft' || e.key === 'End' ? n - 1 : 0) : to)));
  };
  const blur = () => mark(-1);
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
  svg.addEventListener('keydown', key); svg.addEventListener('blur', blur);
  svg.addEventListener('focus', () => { if (active < 0) mark(geo ? geo.n - 1 : -1); });
  let w0 = 0;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w0) > 1) { w0 = el.clientWidth; draw(); } });
  ro.observe(el);
  const theme = () => draw();
  document.addEventListener('rk:prefs', theme);
  draw();
  let tween = 0;
  return {
    // New numbers glide to their place over duration-long (bars grow or shrink, lines bend); new labels redraw, and
    // lines draw in and bars grow from the baseline again.
    update(next) {
      const was = o, d = ms('--rk-duration-long');
      o = { ...o, ...next };
      cancelAnimationFrame(tween);
      const same = was.labels.length === o.labels.length && was.series.length === o.series.length && o.labels.every((l, i) => l === was.labels[i]);
      if (!same) drawn = false;
      if (!same || !d) { draw(); return; }
      const target = o, t0 = performance.now(), ease = bezier('--rk-ease-base');
      // The axis travels with the values: from the old extent to the new one, so it ends where a fresh draw would.
      const extent = (x) => { const v = x.series.flatMap((s) => s.values).filter(Number.isFinite); return [x.min !== undefined ? x.min : x.type === 'bars' ? Math.min(0, ...v) : Math.min(...v), x.max !== undefined ? x.max : Math.max(...v)]; };
      const [lo0, hi0] = extent(was), [lo1, hi1] = extent(target);
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / d), k = ease(t);
        o = { ...target, series: target.series.map((s, si) => ({ ...s, values: s.values.map((v, i) => { const f = was.series[si].values[i]; return Number.isFinite(f) && Number.isFinite(v) ? f + (v - f) * k : v; }) })), min: lo0 + (lo1 - lo0) * k, max: hi0 + (hi1 - hi0) * k };
        draw();
        if (t < 1) tween = requestAnimationFrame(frame); else { o = target; draw(); }
      };
      tween = requestAnimationFrame(frame);
    },
    get active() { return active; },
    destroy() { ro.disconnect(); document.removeEventListener('rk:prefs', theme); hideTip(); },
  };
}

// Shell ------------------------------------------------------------------------------------------------------------
// icon(name, { label, src }): an <svg class="rk-icon"> that uses the icon from the sprite (rekta.icons.svg, inlined in
// the page, or at src). Without label it is decoration (aria-hidden); with one, an image with that name.
export function icon(name, { label = '', src = '' } = {}) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'rk-icon');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', `${src}#rk-i-${name}`);
  s.appendChild(u);
  return s;
}

// titlebar(el, { router }): the title bar of an installed app (.rk-titlebar), shown in the window-controls overlay of
// an installed PWA, or when a native shell (Electron, Tauri, a WebView) sets data-rk-titlebar on the root. It is the
// window's drag area; its back button follows the router and its place line names the current place. The window's
// own controls keep their room (titlebar-area-*).
export function titlebar(el, { router = null } = {}) {
  const place = el.querySelector('.rk-titlebar-place');
  const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
  const paint = () => {
    if (!place || !router) return;
    const p = document.querySelector(`[data-rk-place="${CSS.escape(router.current || '')}"]`), h = p && p.querySelector('.rk-title');
    place.textContent = p && p.dataset.rkParent && h ? h.textContent.trim() : '';
  };
  const geometry = () => docEl().toggleAttribute('data-rk-wco', !!(wco && wco.visible));
  // Another window is the active one: the name steps back (data-rk-inactive). Read after the event, since focus
  // moving into a frame of the page blurs the window first and still leaves the page active.
  const active = () => setTimeout(() => el.toggleAttribute('data-rk-inactive', !document.hasFocus()));
  document.addEventListener('rk:placechange', paint);
  if (wco) wco.addEventListener('geometrychange', geometry);
  addEventListener('focus', active); addEventListener('blur', active);
  paint(); geometry(); active();
  return {
    destroy() {
      document.removeEventListener('rk:placechange', paint); if (wco) wco.removeEventListener('geometrychange', geometry);
      removeEventListener('focus', active); removeEventListener('blur', active); el.removeAttribute('data-rk-inactive');
    },
  };
}

// pwa({ sw, toaster, onChange }): the page as an installable app. Registers the service worker (only where a web app
// manifest is linked and the page is in a secure context), says once it works offline, offers "reload" in a toast
// when a new version waits, and keeps the browser's install prompt for install(). onChange(state) and rk:pwa on
// document follow every change of { supported, installed, canInstall, offlineReady, updateReady }.
export function pwa({ sw = 'sw.js', toaster: toasts = null, onChange = null } = {}) {
  const standalone = () => matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)').matches;
  const state = { supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator && isSecureContext, installed: standalone(), canInstall: false, offlineReady: false, updateReady: false };
  let prompt = null, waiting = null, reg = null, reloading = false;
  const fire = () => { const s = { ...state }; if (onChange) onChange(s); document.dispatchEvent(new CustomEvent('rk:pwa', { detail: s })); };
  const before = (e) => { e.preventDefault(); prompt = e; state.canInstall = true; fire(); };
  const installed = () => { prompt = null; state.canInstall = false; state.installed = true; fire(); if (toasts) toasts.show(tx('installed'), { key: 'rk-pwa' }); };
  function wait(w) {
    waiting = w; state.updateReady = true; fire();
    if (toasts) toasts.show(tx('newVersion'), { key: 'rk-pwa-update', act: { label: tx('reload'), run: () => update() } });
  }
  async function register() {
    if (!state.supported || !sw || !document.querySelector('link[rel="manifest"]')) return;
    try {
      reg = await navigator.serviceWorker.register(sw);
      if (reg.waiting && navigator.serviceWorker.controller) wait(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state !== 'installed') return; if (navigator.serviceWorker.controller) wait(w); else { state.offlineReady = true; fire(); } });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
      await navigator.serviceWorker.ready;
      if (!state.offlineReady) { state.offlineReady = true; fire(); }
    } catch { state.supported = false; fire(); }
  }
  function update() {
    if (!waiting) { if (reg) reg.update(); return false; }
    reloading = true; waiting.postMessage('skip-waiting'); return true;
  }
  async function install() {
    if (!prompt) return false;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    prompt = null; state.canInstall = false; fire();
    return outcome === 'accepted';
  }
  addEventListener('beforeinstallprompt', before);
  addEventListener('appinstalled', installed);
  register();
  return {
    get state() { return { ...state }; },
    install, update,
    check() { if (reg) return reg.update(); return Promise.resolve(); },
    destroy() { removeEventListener('beforeinstallprompt', before); removeEventListener('appinstalled', installed); },
  };
}

// Motion -----------------------------------------------------------------------------------------------------------
// The movements that follow a change of content. Each one has one meaning (docs/motion.md) and takes its duration
// from a token, so reduced motion makes it instant, never skipped.
const shown = (el) => el.getClientRects().length > 0;
const finished = (anims) => Promise.all(anims.map((a) => a.finished.catch(() => {})));
// A control in a one-line bar (the app bar, a row of actions, a row of tags marked data-rk-motion="inline") is neither
// a row nor a tile: a path would lead out of a bar of fixed height, or into the next control. It arrives and leaves
// by a fade only, and grows or shrinks without scaling, its content standing.
const INLINE = '.rk-appbar > *, .rk-actions > *, [data-rk-motion="inline"]';
// reflow(scope, change, { items, size }): FLIP. Whatever change() moves or resizes among the items (scope's children
// by default) glides from where it was to where it is, over duration-moderate. A box that changes size scales from
// its old size and fades its content back in near the end, so text is never seen stretched: a tile resized, a grid
// re-flowed around it. A bar control only glides: it takes its new size at once and its content stands. Resolves
// with change()'s result once everything has settled.
export function reflow(scope, change, { items = null, size = true } = {}) {
  const list = () => (items ? [...(typeof items === 'function' ? items() : items)] : [...scope.children]);
  const before = new Map(list().filter(shown).map((el) => [el, el.getBoundingClientRect()]));
  const out = change();
  const d = ms('--rk-duration-moderate');
  if (!d) return Promise.resolve(out);
  const anims = [], ease = css('--rk-ease-base');
  for (const el of list()) {
    const a = before.get(el);
    if (!a || !shown(el)) continue;
    const b = el.getBoundingClientRect();
    const scale = size && !el.matches(INLINE);
    const dx = a.left - b.left, dy = a.top - b.top, sx = scale && b.width ? a.width / b.width : 1, sy = scale && b.height ? a.height / b.height : 1;
    const resized = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && !resized) continue;
    anims.push(el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }], { duration: d, easing: ease }));
    if (resized) for (const c of el.children) anims.push(c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: d, easing: 'linear' }));
  }
  return finished(anims).then(() => out);
}
// enter(el): something new arrives in a list or a grid: a row slides in by 6px and fades up, a tile builds in, a bar
// control fades in.
export function enter(el) { const a = arrival(el); return a ? a.finished.catch(() => {}) : Promise.resolve(); }
function arrival(el) {
  const d = ms('--rk-duration-short');
  if (!d || !shown(el)) return null;
  const tile = el.classList.contains('rk-tile');
  const frames = tile ? [{ opacity: 0, transform: 'translateY(6px) scale(0.96)' }, { opacity: 1, transform: 'none' }]
    : el.matches(INLINE) ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }];
  return el.animate(frames, { duration: tile ? ms('--rk-duration-moderate') : d, easing: css('--rk-ease-in'), fill: 'backwards' });
}
// leave(el): something goes: a row fades and drifts 12px towards its trailing edge, a tile shrinks and fades, a bar
// control fades. The animation holds its end until the caller hides or removes the element; resolves with it (cancel
// it afterwards).
export function leave(el) {
  const d = ms('--rk-duration-short') * 0.6;
  if (!d || !shown(el)) return Promise.resolve(null);
  const tile = el.classList.contains('rk-tile');
  const frames = tile ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }]
    : el.matches(INLINE) ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }];
  const a = el.animate(frames, { duration: d, easing: css('--rk-ease-out'), fill: 'forwards' });
  return a.finished.then(() => a, () => a);
}
// presence(scope, { items, show }): items come and go by show(item). Those that go leave first; then the rest close
// the gap (FLIP) while those that come enter. A bar control that comes waits, unseen, until the others have made room
// for it, then fades in: the mirror of leaving, so nothing lies over its neighbour. A newer call finishes the one still
// running at once. More than 60 changes at a time are shown at once: motion is for a few things moving, not for a
// whole list replaced.
const presenceRuns = new WeakMap();
export async function presence(scope, { items = () => [...scope.children], show }) {
  const prev = presenceRuns.get(scope);
  if (prev) prev.finish();
  const all = typeof items === 'function' ? items() : [...items];
  const going = all.filter((el) => !el.hidden && !show(el)), coming = all.filter((el) => el.hidden && show(el));
  let done = false, leaving = [], waiting = [];
  const apply = () => { going.forEach((el) => { el.hidden = true; }); coming.forEach((el) => { el.hidden = false; }); };
  const run = { finish() { waiting.forEach((a) => a.finish()); waiting = []; if (done) return; done = true; leaving.forEach((a) => a && a.cancel()); apply(); } };
  presenceRuns.set(scope, run);
  if (!going.length && !coming.length) { done = true; return; }
  if (!ms('--rk-duration-short') || going.length + coming.length > 60) { run.finish(); return; }
  leaving = await Promise.all(going.map(leave));
  if (done) return;
  done = true;
  await reflow(scope, () => {
    apply(); leaving.forEach((a) => a && a.cancel());
    // A bar control's fade is held at its start, unseen, while the others glide.
    for (const el of coming) { const a = arrival(el); if (a && el.matches(INLINE)) { a.pause(); waiting.push(a); } }
  }, { items: () => all.filter((el) => !el.hidden || going.includes(el)), size: false });
  waiting.forEach((a) => a.play());
  await finished(waiting);
  waiting = [];
  if (presenceRuns.get(scope) === run) presenceRuns.delete(scope);
}
// Several tiles with news within duration-moderate show it one after another in reading order (the document's),
// duration-greet apart, four steps at most: the rest go with the fourth. Each tileUpdate() starts its animations at
// once; the calls made together are sorted in a microtask, before the frame that would show them, and each one's
// animations wait for its step.
let news = null;
function greet(tile, anims) {
  if (!news) news = { t0: -Infinity, n: 0, batch: [] };
  news.batch.push({ tile, anims });
  if (news.batch.length > 1) return;
  queueMicrotask(() => {
    const now = performance.now(), batch = news.batch.sort((a, b) => (a.tile.compareDocumentPosition(b.tile) & 4 ? -1 : 1));
    news.batch = [];
    if (now - news.t0 > ms('--rk-duration-moderate')) { news.t0 = now; news.n = 0; }
    const step = ms('--rk-duration-greet');
    for (const { anims } of batch) {
      const wait = Math.max(0, news.t0 + Math.min(news.n, 3) * step - now);
      news.n += 1;
      for (const a of anims) a.effect.updateTiming({ delay: a.effect.getTiming().delay + wait });
    }
  });
}
// indicate(control, content): a short indicator (a volume or a brightness being set) stands in place of a control:
// the control turns away as a live tile does for a new status, and the indicator turns in; timing.level after the
// last call it turns back. A call while it stands changes it in place: a reading that keeps changing is no news. The
// control's own children are hidden meanwhile, and data-rk-indicating is on it. The words to hear go through a live
// region, not through this.
const indicating = new WeakMap();
export function indicate(control, content) {
  let s = indicating.get(control);
  const back = () => {
    const t = indicating.get(control);
    if (!t) return;
    indicating.delete(control);
    tileUpdate(control, () => { t.node.remove(); t.hid.forEach((k) => { k.hidden = false; }); control.removeAttribute('data-rk-indicating'); }, { kind: 'flip' });
  };
  if (s) {
    if (s.node !== content) { s.node.replaceWith(content); s.node = content; }
  } else {
    s = { node: content, hid: [], timer: 0 };
    indicating.set(control, s);
    tileUpdate(control, () => {
      s.hid = [...control.children].filter((k) => !k.hidden);
      s.hid.forEach((k) => { k.hidden = true; });
      control.appendChild(s.node);
      control.setAttribute('data-rk-indicating', '');
    }, { kind: 'flip' });
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(back, ms('--rk-duration-level'));
}
// tileUpdate(tile, change, { kind }): a live tile has news. 'peek' (a new number or line): the new content rises
// from peek-travel of its height below while the old one leaves upwards by as much, over duration-moderate. 'flip' (a
// new status): the tile turns flip-angle away around its horizontal axis, changes, and turns back. What peeks is the
// tile's .rk-stat, or the part a page marks data-rk-peek (a count in an app-bar control). A continuous reading
// (frames a second) is no news: it updates in place. Inside a live region (live()) the change already waits while the
// region is held. News on several tiles at once comes one after another (greet).
export function tileUpdate(tile, change, { kind = 'peek' } = {}) {
  const d = ms('--rk-duration-moderate');
  if (!d || !shown(tile)) { change(); return Promise.resolve(); }
  if (kind === 'flip') {
    const p = num('--rk-turnstile-perspective') || 800, turn = num('--rk-flip-angle');
    const a = tile.animate([{ transform: `perspective(${p}px) rotateX(0deg)` }, { transform: `perspective(${p}px) rotateX(${-turn}deg)` }], { duration: d / 2, easing: css('--rk-ease-out'), fill: 'forwards' });
    greet(tile, [a]);
    return a.finished.catch(() => {}).then(() => {
      change();
      a.cancel();
      return tile.animate([{ transform: `perspective(${p}px) rotateX(${turn}deg)` }, { transform: `perspective(${p}px) rotateX(0deg)` }], { duration: d / 2, easing: css('--rk-ease-in') }).finished.catch(() => {});
    });
  }
  const target = tile.querySelector('.rk-stat, [data-rk-peek]') || tile;
  const was = target.textContent;
  const ghost = target.cloneNode(true);
  const tr = tile.getBoundingClientRect(), r = target.getBoundingClientRect();
  change();
  if (target.textContent === was || target === tile) return Promise.resolve();
  ghost.setAttribute('aria-hidden', 'true'); ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
  ghost.style.cssText = `position:absolute;left:${r.left - tr.left}px;top:${r.top - tr.top}px;width:${r.width}px;margin:0;pointer-events:none`;
  tile.appendChild(ghost);
  tile.style.overflow = 'hidden';                                                    // the old number leaves through the edge
  const travel = num('--rk-peek-travel') * 100;
  const out = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-travel}%)` }], { duration: d * 0.6, easing: css('--rk-ease-out'), fill: 'forwards' });
  const inn = target.animate([{ opacity: 0, transform: `translateY(${travel}%)` }, { opacity: 1, transform: 'none' }], { duration: d * 0.8, delay: d * 0.2, easing: css('--rk-ease-in'), fill: 'backwards' });
  greet(tile, [out, inn]);
  return finished([out, inn]).then(() => { ghost.remove(); if (!tile.querySelector('.rk-stat[aria-hidden]')) tile.style.overflow = ''; });
}
// nudge(el, direction): a part that answers a gesture nobody can see (a swipe) hints at it when it is only tapped: it
// moves nudge-distance the gesture's way ('left', 'right', 'up', 'down') and back, duration-short each way on
// ease-landing, and rests where it was. The movement adds to the part's own transform, so a press still shows under
// it; a tap while it moves starts it again. Under reduced motion it stays still: the words that name the gesture say it.
const nudges = new WeakMap();
export function nudge(el, direction) {
  const d = ms('--rk-duration-short'), n = num('--rk-nudge-distance');
  const to = { left: [-n, 0], right: [n, 0], up: [0, -n], down: [0, n] }[direction];
  if (!to) throw new Error(`unknown nudge direction ${direction}`);
  if (nudges.has(el)) nudges.get(el).cancel();
  if (!d || !shown(el)) return Promise.resolve();
  const ease = css('--rk-ease-landing');
  const a = el.animate([{ transform: 'none', easing: ease }, { transform: `translate(${to[0]}px, ${to[1]}px)`, easing: ease }, { transform: 'none' }], { duration: 2 * d, composite: 'add' });
  nudges.set(el, a);
  return a.finished.catch(() => {}).then(() => { if (nudges.get(el) === a) nudges.delete(el); });
}
// sparkTo(line, points): a live line moves to its new points over duration-long instead of jumping. Points are an
// SVG points list; with the same number of points each one travels, otherwise the line is redrawn at once.
const sparkRuns = new WeakMap();
export function sparkTo(line, points) {
  const parse = (s) => (s || '').trim().split(/\s+/).filter(Boolean).map((p) => p.split(',').map(Number));
  const from = parse(line.getAttribute('points')), to = parse(points), d = ms('--rk-duration-long');
  cancelAnimationFrame(sparkRuns.get(line) || 0);
  if (!d || from.length !== to.length) { line.setAttribute('points', points); return; }
  const t0 = performance.now(), ease = bezier('--rk-ease-base');
  const step = (now) => {
    const t = Math.min(1, (now - t0) / d), k = ease(t);
    line.setAttribute('points', to.map(([x, y], i) => `${(from[i][0] + (x - from[i][0]) * k).toFixed(1)},${(from[i][1] + (y - from[i][1]) * k).toFixed(1)}`).join(' '));
    if (t < 1) sparkRuns.set(line, requestAnimationFrame(step));
  };
  sparkRuns.set(line, requestAnimationFrame(step));
}
// crossfade(change): a change of the whole look (theme, accent) fades over duration-short instead of flipping, where
// the browser has view transitions. Rekta's timing applies to its own transitions only (data-rk-crossfade on the
// root while one runs): an app's own root view transitions keep theirs.
export function crossfade(change) {
  if (!ms('--rk-duration-short') || !document.startViewTransition) { change(); return Promise.resolve(); }
  docEl().setAttribute('data-rk-crossfade', '');
  return document.startViewTransition(change).finished.catch(() => {}).finally(() => docEl().removeAttribute('data-rk-crossfade'));
}

// Inputs -----------------------------------------------------------------------------------------------------------
// combobox(input, { options, source, onSelect, free }): a text field with a list of choices that filters as you type.
// options is a list of strings or { label, value, group, hint, keywords }, or a function returning one; source(q)
// instead returns them as a promise (the list shows the loading line while it waits). The list floats below the
// field like a menu. ↓ or Alt+↓ opens, ↑ ↓ move, Enter chooses, Escape closes, then clears; a click chooses. Without
// free, the field only keeps a choice from the list: leaving it with other text puts the last choice back.
export function combobox(input, { options = [], source = null, onSelect = null, free = false } = {}) {
  const wrap = input.closest('.rk-combo') || input.parentElement;
  const button = wrap.querySelector('.rk-combo-btn');
  const list = document.createElement('ul');
  list.className = 'rk-float rk-combo-list';
  list.id = uid('rk-combo');
  list.setAttribute('role', 'listbox');
  if (canPopover) list.setAttribute('popover', 'manual'); else list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('autocomplete', 'off'); input.spellcheck = false;
  if (button) { button.tabIndex = -1; button.setAttribute('aria-hidden', 'true'); }
  const norm = (o) => (typeof o === 'string' ? { label: o, value: o } : { value: o.label, ...o });
  let shown = [], active = -1, chosen = input.value ? { label: input.value, value: input.dataset.value || input.value } : null, asked = 0;
  const all = () => (typeof options === 'function' ? options() : options).map(norm);
  async function render() {
    const q = input.value.trim(), n = ++asked;
    let opts;
    if (source) {
      const wait = setTimeout(() => list.setAttribute('aria-busy', 'true'), ms('--rk-duration-busy-delay'));
      try { opts = (await source(q)).map(norm); } catch { opts = null; }
      clearTimeout(wait); list.removeAttribute('aria-busy');
      if (n !== asked) return;
    } else opts = all();
    shown = [];
    if (opts) opts.forEach((o, i) => { const s = source ? 1 : matchScore(o.label, o.keywords, q === (chosen && chosen.label) ? '' : q); if (s) shown.push({ o, s, i }); });
    if (!source && q && q !== (chosen && chosen.label)) shown.sort((a, b) => b.s - a.s || a.i - b.i);
    list.replaceChildren();
    let group = null;
    shown.forEach(({ o }, k) => {
      if ((o.group || '') !== group) {
        group = o.group || '';
        if (group) { const h = document.createElement('li'); h.className = 'rk-menu-label'; h.setAttribute('role', 'presentation'); h.textContent = group; list.appendChild(h); }
      }
      const li = document.createElement('li');
      li.className = 'rk-menu-item'; li.id = `${list.id}-o${k}`; li.setAttribute('role', 'option');
      if (chosen && o.value === chosen.value) li.setAttribute('data-rk-chosen', '');
      li.append(o.label);
      if (o.hint) { const h = document.createElement('span'); h.className = 'rk-menu-key'; h.textContent = o.hint; li.appendChild(h); }
      li.addEventListener('pointermove', () => mark(k));
      li.addEventListener('pointerdown', (e) => e.preventDefault());               // keep focus in the field
      li.addEventListener('click', () => choose(k));
      list.appendChild(li);
    });
    if (!shown.length) {
      const li = document.createElement('li'); li.className = 'rk-empty rk-palette-empty'; li.setAttribute('role', 'presentation');
      li.textContent = opts ? (q ? tx('noMatch', q) : tx('nothingYet')) : tx('loadFailed');
      list.appendChild(li);
    }
    const at = chosen ? shown.findIndex(({ o }) => o.value === chosen.value) : -1;
    mark(q && q !== (chosen && chosen.label) ? 0 : at);
    if (isOpen(list)) place(list, input);
  }
  function mark(k) {
    active = shown.length ? Math.max(-1, Math.min(k, shown.length - 1)) : -1;
    list.querySelectorAll('[role=option]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
    const o = active >= 0 && list.querySelector(`#${CSS.escape(`${list.id}-o${active}`)}`);
    if (o) { input.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  }
  function open() {
    if (isOpen(list)) return;
    list.style.minWidth = `${input.offsetWidth}px`;
    openFloat(list); place(list, input);
    input.setAttribute('aria-expanded', 'true');
    render();
  }
  function close() {
    if (!isOpen(list)) return;
    closeFloat(list); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function choose(k) {
    const pick = shown[k];
    if (!pick) return;
    chosen = { label: pick.o.label, value: pick.o.value };
    input.value = pick.o.label; input.dataset.value = pick.o.value;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onSelect) onSelect(pick.o);
  }
  function settle() {
    const q = input.value.trim();
    if (free || !q || (chosen && q === chosen.label)) { if (!q && chosen && !free) { chosen = null; delete input.dataset.value; if (onSelect) onSelect(null); } return; }
    const exact = all().find((o) => o.label.toLowerCase() === q.toLowerCase());
    if (exact && !source) { chosen = { label: exact.label, value: exact.value }; input.value = exact.label; input.dataset.value = exact.value; if (onSelect) onSelect(exact); }
    else input.value = chosen ? chosen.label : '';
  }
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen(list)) open(); else mark(active + 1 >= shown.length ? 0 : active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen(list)) mark(active <= 0 ? shown.length - 1 : active - 1); }
    else if (e.key === 'Enter') { if (isOpen(list)) { e.preventDefault(); choose(active); } }
    else if (e.key === 'Escape') {
      if (isOpen(list)) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; settle(); }
    } else if (e.key === 'Tab') close();
  };
  const typed = () => { if (!isOpen(list)) open(); else render(); };
  const blur = () => { close(); settle(); };
  const toggle = (e) => { e.preventDefault(); if (isOpen(list)) close(); else { input.focus(); open(); } };
  const outside = (e) => { if (isOpen(list) && !list.contains(e.target) && !wrap.contains(e.target)) close(); };
  const reflow = () => { if (isOpen(list)) place(list, input); };
  input.addEventListener('keydown', key);
  input.addEventListener('input', typed);
  input.addEventListener('blur', blur);
  input.addEventListener('click', () => { if (!isOpen(list)) open(); });
  if (button) { button.addEventListener('pointerdown', (e) => e.preventDefault()); button.addEventListener('click', toggle); }
  document.addEventListener('pointerdown', outside, true);
  addEventListener('resize', reflow); addEventListener('scroll', reflow, true);
  return {
    open, close,
    get value() { return chosen ? chosen.value : (free ? input.value : null); },
    set(value) { const o = all().find((x) => x.value === value); chosen = o ? { label: o.label, value: o.value } : null; input.value = o ? o.label : ''; if (o) input.dataset.value = o.value; else delete input.dataset.value; },
    destroy() {
      input.removeEventListener('keydown', key); input.removeEventListener('input', typed); input.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', reflow); removeEventListener('scroll', reflow, true); list.remove();
    },
  };
}

// stepper(el): a number field between − and + buttons (.rk-stepper holding an input[type=number] and two buttons with
// data-rk-step="-1" and "1"). A press steps once; held, it repeats. The buttons say when the limit is reached.
export function stepper(el) {
  const input = el.querySelector('input'), btns = [...el.querySelectorAll('[data-rk-step]')];
  let repeat = 0, delay = 0;
  const paint = () => {
    const v = input.valueAsNumber, min = input.min === '' ? -Infinity : +input.min, max = input.max === '' ? Infinity : +input.max;
    for (const b of btns) { const up = +b.dataset.rkStep > 0, at = Number.isFinite(v) && (up ? v >= max : v <= min); b.setAttribute('aria-disabled', String(at)); }
  };
  function step(b) {
    if (b.getAttribute('aria-disabled') === 'true' || input.disabled || input.getAttribute('aria-disabled') === 'true') return false;
    const n = +b.dataset.rkStep;
    try { if (n > 0) input.stepUp(n); else input.stepDown(-n); } catch { input.value = String((+input.value || 0) + n); }
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    paint();
    return true;
  }
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = 0; };
  const down = (e) => {
    const b = e.target.closest('[data-rk-step]');
    if (!b || e.button !== 0) return;
    e.preventDefault(); input.focus({ preventScroll: true });
    if (!step(b)) return;
    delay = setTimeout(() => { repeat = setInterval(() => { if (!step(b)) stop(); }, 80); }, 400);
  };
  const click = (e) => { const b = e.target.closest('[data-rk-step]'); if (b && e.detail === 0) step(b); };    // keyboard
  el.addEventListener('pointerdown', down);
  el.addEventListener('click', click);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, stop);
  input.addEventListener('input', paint);
  for (const b of btns) { b.type = 'button'; b.tabIndex = -1; }
  paint();
  return { destroy() { stop(); el.removeEventListener('pointerdown', down); el.removeEventListener('click', click); input.removeEventListener('input', paint); } };
}

// Segments: the accent block slides from the old choice to the new one over duration-short; the new segment takes
// its fill when the block arrives.
const segChosen = new WeakMap();
const segOf = (g) => { const i = g.querySelector('input:checked'); return i ? i.closest('label') : null; };
function onSegment(e) {
  const input = e.target;
  if (!input.matches || !input.matches('.rk-segments input[type=radio]')) return;
  const g = input.closest('.rk-segments'), to = input.closest('label'), from = segChosen.get(g);
  segChosen.set(g, to);
  const d = ms('--rk-duration-short');
  if (!from || from === to || !d || !shown(from)) return;
  const gr = g.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const block = document.createElement('span');
  block.className = 'rk-segments-slide'; block.setAttribute('aria-hidden', 'true');
  block.style.cssText = `left:${b.left - gr.left}px;top:${b.top - gr.top}px;width:${b.width}px;height:${b.height}px`;
  g.querySelectorAll('.rk-segments-slide').forEach((x) => x.remove());
  g.querySelectorAll('label[data-rk-sliding]').forEach((x) => x.removeAttribute('data-rk-sliding'));
  g.appendChild(block);
  g.setAttribute('data-rk-sliding', ''); to.setAttribute('data-rk-sliding', '');
  block.animate([{ transform: `translateX(${a.left - b.left}px) scaleX(${a.width / b.width})` }, { transform: 'none' }], { duration: d, easing: css('--rk-ease-base') })
    .finished.catch(() => {}).then(() => {
      if (!block.isConnected) return;                                                  // a newer slide took over
      block.remove(); to.removeAttribute('data-rk-sliding');
      getComputedStyle(to).backgroundColor;                                            // settle without a transition
      g.removeAttribute('data-rk-sliding');
    });
}

// A slider (.rk-range) fills up to its value; an <output> right after it shows the value (with data-unit).
function rangeFill(r) {
  const min = +r.min || 0, max = r.max === '' ? 100 : +r.max, v = +r.value;
  r.style.setProperty('--_rk-v', `${((v - min) / (max - min || 1)) * 100}%`);
  const out = r.nextElementSibling;
  if (out && out.tagName === 'OUTPUT') out.textContent = `${r.value}${out.dataset.unit || ''}`;
}
const onRange = (e) => { if (e.target.matches && e.target.matches('input.rk-range')) rangeFill(e.target); };

// drop(el, { onFiles, accept }): a .rk-drop zone around a file input takes files dropped on it or chosen with the
// input. While files are dragged over it, it gets data-rk-over. Dropping files elsewhere on the page never opens
// them in the browser while a zone is mounted. While its input is disabled (or aria-disabled) it takes none.
export function drop(el, { onFiles = null, accept = null } = {}) {
  const input = el.querySelector('input[type=file]');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const off = () => !!input && (input.disabled || input.getAttribute('aria-disabled') === 'true');
  const ok = (f) => !accept || accept.split(',').some((a) => { a = a.trim(); return a.startsWith('.') ? f.name.toLowerCase().endsWith(a.toLowerCase()) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a; });
  const give = (files) => { const list = [...files].filter(ok); if (list.length && onFiles) onFiles(list, [...files].filter((f) => !ok(f))); };
  const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (off()) return; depth += 1; el.setAttribute('data-rk-over', ''); };
  const over = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = off() ? 'none' : 'copy'; };
  const leave = () => { depth = Math.max(0, depth - 1); if (!depth) el.removeAttribute('data-rk-over'); };
  const dropped = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; el.removeAttribute('data-rk-over'); if (!off()) give(e.dataTransfer.files); };
  const page = (e) => { if (hasFiles(e) && !el.contains(e.target)) { e.preventDefault(); if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'; } };
  const chose = () => { give(input.files); input.value = ''; };
  el.addEventListener('dragenter', enter); el.addEventListener('dragover', over); el.addEventListener('dragleave', leave); el.addEventListener('drop', dropped);
  addEventListener('dragover', page); addEventListener('drop', page);
  if (input) { if (accept) input.accept = accept; input.addEventListener('change', chose); }
  return {
    destroy() {
      el.removeEventListener('dragenter', enter); el.removeEventListener('dragover', over); el.removeEventListener('dragleave', leave); el.removeEventListener('drop', dropped);
      removeEventListener('dragover', page); removeEventListener('drop', page); if (input) input.removeEventListener('change', chose);
    },
  };
}

// Start --------------------------------------------------------------------------------------------------------------
// The defaults for a page: restore the user's prefs, press on tiles, sheets, steppers, sliders, switches, tile grids
// (one tab stop, arrows), and the first paint's build-in. An embedded page whose host owns theme, density and motion passes restore: false.
export function start({ root = document, restore = true, locale: tag = '', strings: words = null, focusFallback = null } = {}) {
  if (tag) setLocale(tag);
  if (focusFallback) fallbackFocus = focusFallback;
  if (words) setStrings(words);
  if (restore) prefs.restore();
  const parts = [press(root)];
  root.querySelectorAll('dialog.rk-sheet').forEach((d) => parts.push(sheet(d)));
  root.querySelectorAll('.rk-stepper').forEach((s) => parts.push(stepper(s)));
  root.querySelectorAll('.rk-tiles').forEach((g) => { if (!g.hasAttribute('data-rk-select') && g.querySelector(OPENS)) parts.push(grid(g)); });
  root.querySelectorAll('input.rk-range').forEach(rangeFill);
  root.querySelectorAll('.rk-toggle input[type=checkbox]').forEach((i) => i.setAttribute('role', 'switch'));
  parts.push(tips());
  root.querySelectorAll('.rk-segments').forEach((g) => segChosen.set(g, segOf(g)));
  document.addEventListener('input', onRange);
  document.addEventListener('change', onSegment);
  parts.push({ destroy() { document.removeEventListener('input', onRange); document.removeEventListener('change', onSegment); } });
  arrive(docEl());
  return { destroy() { parts.forEach((p) => p.destroy()); if (focusFallback && fallbackFocus === focusFallback) fallbackFocus = null; } };
}
