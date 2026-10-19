/*!
 * Rekta Design, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.
 * Source: https://github.com/DerDaehne/Rekta-Design
 * Commit: 7b0f7eadff45b7cc273a3f5ea04cc56464d2b697
 * Tag: v0.4.0
 * Generator: scripts/build.mjs of Rekta Design
 * Output: dist/rekta.d.ts
 * SHA-256 of everything below this header: cf5e2c52205ecfc2391ca027f04db9b189ec512e28ab05984b88108e396347aa
 * License: MIT, Copyright (c) 2026 DerDaehne; full text in NOTICE.
 * Notice: some token values derive from the Porsche Design System source code (Apache License 2.0).
 * No Porsche fonts, icons, assets or marks are included.
 */
// Rekta Design: TypeScript declarations for rekta.js. Written by hand next to the script; docs/behaviour.md is the
// prose for every member. --check fails when an export of rekta.js has no declaration here, or this declares one
// that rekta.js does not export.

/** Something that stops listening and gives back what it changed. */
export interface Destroyable { destroy(): void; }

type StatusName = 'info' | 'success' | 'warning' | 'error';
type Word = string | ((...args: any[]) => string);
/** The forms of an entry that counts, one per category of Intl.PluralRules for the locale; `other` is the fallback. */
export interface PluralForms { zero?: Word; one: Word; two?: Word; few?: Word; many?: Word; other: Word; }

export declare const version: string;

// Words and numbers ---------------------------------------------------------------------------------------------------

/** Every word rekta.js shows or says. Entries that count (undoWindow, selected, guardText, updatesWaiting,
 * needAttention) take plural forms. */
export declare const strings: Record<string, Word | PluralForms>;
/** Replaces those words; `null` gives back the English ones. */
export declare function setStrings(partial: Record<string, Word | PluralForms> | null): void;
export declare function setLocale(tag: string): void;
/** The locale in use: the one set, else the document's lang, else the browser's. */
export declare function locale(): string;
/** A figure as charts show it: compact from a thousand up, in the locale's separators. */
export declare function number(v: number, options?: { compact?: boolean }): string;

// Tokens, prefs, keys -------------------------------------------------------------------------------------------------

export declare const tokens: {
  value(name: string, el?: Element): string;
  ms(name: string, el?: Element): number;
  number(name: string, el?: Element): number;
  /** A length in px, whatever form it is written in (px, rem, calc()). */
  px(name: string, el?: Element): number;
};

type PrefName = 'theme' | 'density' | 'motion';
export declare const prefs: {
  key: string;
  read(): Partial<Record<PrefName, string>>;
  write(all: Partial<Record<PrefName, string>>): void;
  get(name: 'theme'): 'system' | 'light' | 'dark';
  get(name: 'density'): 'auto' | 'comfortable' | 'compact';
  get(name: 'motion'): 'system' | 'on' | 'off';
  set(name: 'theme', value: 'system' | 'light' | 'dark', options?: { remember?: boolean }): void;
  set(name: 'density', value: 'auto' | 'comfortable' | 'compact', options?: { remember?: boolean }): void;
  set(name: 'motion', value: 'system' | 'on' | 'off', options?: { remember?: boolean }): void;
  restore(): void;
};

export declare const keys: {
  /** A key layer: `handler` returns true when it used the key (it is then prevented). Returns the remover. */
  on(priority: number, handler: (e: KeyboardEvent) => boolean | void): () => void;
  escapeIsFree(e: KeyboardEvent): boolean;
  isEditable(target: EventTarget | null): boolean;
};

// Start ---------------------------------------------------------------------------------------------------------------

export interface StartOptions {
  root?: Document | Element;
  restore?: boolean;
  locale?: string;
  strings?: Record<string, Word | PluralForms> | null;
  /** Where focus goes when the control it should return to is gone; `null` goes on to the defaults. */
  focusFallback?: (() => HTMLElement | null) | null;
}
export declare function start(options?: StartOptions): Destroyable;
export declare function press(scope?: Document | Element): Destroyable;

// Places --------------------------------------------------------------------------------------------------------------

export declare function arrive(el: Element): void;
export declare const turn: {
  leave(place: Element, options?: { pressed?: Element | null; back?: boolean }): Promise<void>;
  enter(place: Element, options?: { back?: boolean; focus?: HTMLElement | null; arriving?: boolean }): Promise<void>;
  finish(): void;
  readonly running: boolean;
};

export interface PlaceChange { from: string | null; to: string; back: boolean; }
export interface Router extends Destroyable {
  readonly current: string;
  readonly item: string | null;
  readonly below: string | null;
  readonly params: URLSearchParams;
  navigate(nameOrUrl: string, options?: { replace?: boolean; pressed?: Element | null }): Promise<unknown>;
  open(item: string | null, options?: { replace?: boolean }): void;
  setParams(params: string | URLSearchParams | Record<string, string>): void;
  back(name?: string): boolean;
  /** `fn` may hold a change of place: true at once, else false or a promise of the answer. */
  guard(fn: () => boolean | Promise<boolean>): () => void;
  onItem(place: string, fn: (item: string | null, info: { back: boolean; initial: boolean; params: URLSearchParams }) => string | void, options?: { push?: () => boolean }): () => void;
  urlOf(name: string, item?: string | null, params?: string | URLSearchParams): string;
}
export declare function places(options?: { root?: Document | Element; mode?: 'hash' | 'path'; base?: string; home?: string; title?: string; onChange?: (change: PlaceChange) => void }): Router;

export declare function panorama(el: HTMLElement, options?: { pivot?: HTMLElement | null }): Destroyable & {
  goTo(section: Element, options?: { focus?: boolean; instant?: boolean }): void;
  readonly current: Element | null;
};

export declare function pivot(el: HTMLElement, options?: {
  onSelect?: (index: number, item: HTMLElement) => void;
  turn?: typeof turn | null;
}): Destroyable & {
  /** `silent` changes the facet without calling onSelect. */
  select(index: number, options?: { focus?: boolean; silent?: boolean }): void;
  readonly wide: boolean;
  layout(): void;
};

export declare function strip(el: HTMLElement): Destroyable & { layout(): void };

// Feedback ------------------------------------------------------------------------------------------------------------

export type ToastEnd = 'expired' | 'undone' | 'replaced' | 'acted' | 'dismissed';
export interface ToastOptions {
  key?: string;
  undo?: (() => void) | null;
  from?: HTMLElement | null;
  action?: string;
  act?: { label: string; run: () => void } | null;
  status?: StatusName | '';
  /** The undo window in ms (default: duration-toast). */
  windowMs?: number;
  onEnd?: ((reason: ToastEnd) => void) | null;
}
export interface Toast {
  readonly key: string;
  readonly el: HTMLElement;
  readonly action: string;
  undo: (() => void) | null;
  leave(doUndo?: boolean, reason?: ToastEnd): void;
  /** What is left of the window; 0 ends the toast, held or not. */
  setRemaining(ms: number): void;
  readonly remaining: number;
  readonly held: boolean;
  update(text: string, undo: (() => void) | null, options?: { windowMs?: number; onEnd?: ((reason: ToastEnd) => void) | null }): void;
}
export interface Toaster extends Destroyable {
  show(text: string, options?: ToastOptions): Toast;
  readonly open: Toast | null;
  dismiss(): void;
}
export declare function toaster(region: HTMLElement): Toaster;

export interface BannerState {
  word?: string;
  status?: StatusName;
  alert?: boolean;
  text: string;
  action?: string | { label: string; href: string };
  /** The word before the time ("since"). */
  since?: string;
  /** Replaces the time line ("until 18:00"). */
  until?: string;
  on?: string;
  off?: string;
}
export declare function banner(el: HTMLElement, options: {
  states: Record<string, BannerState>;
  order?: string[];
  appbar?: HTMLElement | null;
  liveWord?: HTMLElement | null;
  toaster?: Toaster | null;
  onAction?: ((name: string) => void) | null;
}): Destroyable & {
  /** `since`: the real start (a Date, or anything new Date() reads), or false when it is unknown. */
  set(name: string, on: boolean, options?: { from?: HTMLElement | null; since?: Date | string | number | false | null }): void;
  toggle(name: string, options?: { from?: HTMLElement | null; since?: Date | string | number | false | null }): void;
  is(name: string): boolean;
  readonly shown: string | null;
};

/** With `dirty`, a close request asks in the sheet before unsaved input goes. Called again for an attached sheet, it
 * updates the options and returns the same handle. */
export declare function sheet(dialog: HTMLDialogElement, options?: { dirty?: (() => boolean) | null }): Destroyable & { readonly asking: boolean };
export declare function busy<T>(region: HTMLElement, work: Promise<T> | (() => Promise<T>)): Promise<T>;
export declare function pending<T>(button: HTMLElement, work: Promise<T> | (() => Promise<T>), options?: { label?: string }): Promise<T | undefined>;

// Floating surfaces, collections --------------------------------------------------------------------------------------

export declare function place(el: HTMLElement, anchor: Element): void;

export declare function menu(trigger: HTMLElement, el: HTMLElement, options?: {
  onSelect?: (item: HTMLElement) => void;
  summary?: string | null;
}): Destroyable & {
  open(index?: number): void;
  close(focusTrigger?: boolean): void;
  set(isChecked: (item: HTMLElement) => boolean): void;
};

export interface Selection extends Destroyable {
  selected(): HTMLElement[];
  only(item: HTMLElement, options?: { show?: boolean }): void;
  toggle(item: HTMLElement): void;
  clear(): void;
  selectAll(): void;
  readonly mode: boolean;
  refresh(): void;
}
export declare function select(el: HTMLElement, options?: {
  items?: string;
  onShow?: ((item: HTMLElement) => void) | null;
  onChange?: ((items: HTMLElement[], info: { mode: boolean }) => void) | null;
  appbar?: HTMLElement | null;
}): Selection;

export declare function table(el: HTMLTableElement | HTMLElement, options?: {
  onSort?: (sort: { column: number; dir: 'ascending' | 'descending'; th: HTMLTableCellElement }) => void;
  select?: boolean | null;
  onShow?: ((row: HTMLElement) => void) | null;
  onSelect?: ((rows: HTMLElement[], info: { mode: boolean }) => void) | null;
  appbar?: HTMLElement | null;
  columns?: boolean | { key: string } | null;
  edit?: { onCommit(row: HTMLElement, cell: HTMLElement, value: string, old: string): void | Promise<unknown> } | null;
}): Destroyable & {
  selected(): HTMLElement[];
  only(row: HTMLElement, options?: { show?: boolean }): void;
  clear(): void;
  selectAll(): void;
  readonly mode: boolean;
  sort(column: number, dir?: 'ascending' | 'descending'): void;
  hide(i: number): void;
  show(i: number): void;
  hidden(): number[];
  width(i: number, px?: number | null): number | void;
  edit(cell: HTMLElement): void;
  refresh(): void;
};

export declare function split(el: HTMLElement, options?: { key?: string | null }): Destroyable & {
  show(pane: 'detail' | 'list', options?: { focus?: boolean }): void;
  reveal(dir?: number): void;
  readonly sideways: boolean;
  readonly showing: 'detail' | 'list';
};

export interface PaletteItem { label: string; group?: string; keys?: string; keywords?: string; href?: string; run?: () => void; }
export declare function palette(el: HTMLElement, options?: {
  items?: () => PaletteItem[];
  trigger?: HTMLElement | null;
  router?: Router | null;
  shortcut?: string;
}): Destroyable & { open(): void; close(): void; readonly isOpen: boolean };

export declare function appbar(el: HTMLElement, options?: { more?: HTMLElement | null }): Destroyable & { layout(): void };

// Forms ---------------------------------------------------------------------------------------------------------------

export declare function disable(control: HTMLElement, reason: string | null): void;
export declare function confirm(options: {
  title: string;
  text?: string;
  kicker?: string;
  ok?: string;
  cancel?: string;
  safe?: 'ok' | 'cancel';
  root?: Element;
}): Promise<boolean>;
export declare function form(el: HTMLFormElement, options?: {
  validators?: Record<string, (value: string, control: HTMLElement) => string | void | null | undefined>;
  onSubmit?: ((values: Record<string, string>) => void | Promise<unknown>) | null;
  submit?: HTMLElement | null;
}): Destroyable & {
  check(): boolean;
  setErrors(map: Record<string, string>, message?: string): void;
  clear(): void;
  /** Each control in error, with its message. */
  readonly errors: { c: HTMLElement; m: string }[];
};
export declare function guard(el: HTMLFormElement, options?: { router?: Router | null; what?: string }): Destroyable & {
  readonly dirty: boolean;
  changed(): HTMLElement[];
  clean(): void;
  restore(): void;
};

export interface ComboOption { label: string; value?: string; group?: string; hint?: string; keywords?: string; }
export declare function combobox(input: HTMLInputElement, options?: {
  options?: (string | ComboOption)[] | (() => (string | ComboOption)[]);
  source?: ((query: string) => Promise<(string | ComboOption)[]>) | null;
  onSelect?: ((option: { label: string; value: string } | null) => void) | null;
  free?: boolean;
}): Destroyable & { open(): void; close(): void; readonly value: string | null; set(value: string): void };
export declare function stepper(el: HTMLElement): Destroyable;
export declare function drop(el: HTMLElement, options?: { onFiles?: ((accepted: File[], refused: File[]) => void) | null; accept?: string | null }): Destroyable;

// Desktop -------------------------------------------------------------------------------------------------------------

export declare function contextMenu(scope: Element, el: HTMLElement, options?: {
  target?: string;
  onOpen?: ((target: HTMLElement, event: Event) => boolean | void) | null;
  onSelect?: ((item: HTMLElement, target: HTMLElement) => void) | null;
}): Destroyable & { open(target: HTMLElement): void; close(): void; readonly target: HTMLElement | null };

export declare function tree(el: HTMLElement, options?: {
  onShow?: ((li: HTMLElement) => void) | null;
  onToggle?: ((li: HTMLElement, open: boolean) => void) | null;
}): Destroyable & {
  expand(li: HTMLElement, open: boolean): void;
  expandAll(open?: boolean): void;
  select(li: HTMLElement, show?: boolean): void;
  selected(): HTMLElement | null;
  refresh(): void;
};

export declare function sortable(list: HTMLElement, options?: {
  items?: string;
  handle?: string;
  onMove?: ((from: number, to: number, item: HTMLElement) => void) | null;
}): Destroyable & { move(item: HTMLElement, to: number): boolean; refresh(): void };

export declare function virtual(el: HTMLElement, options: {
  count?: number;
  render: (i: number, row: HTMLElement) => void;
  onShow?: ((i: number) => void) | null;
  onChange?: ((indices: number[], info: { mode: boolean }) => void) | null;
  appbar?: HTMLElement | null;
  label?: string;
}): Destroyable & {
  refresh(count?: number): void;
  scrollTo(i: number): void;
  selected(): number[];
  only(i: number): void;
  clear(): void;
  readonly mode: boolean;
  readonly count: number;
};

export interface UndoAction { label: string; run: () => unknown; undo: () => unknown; redo?: () => unknown; }
export declare function undoStack(options?: { toaster?: Toaster | null; limit?: number }): Destroyable & {
  do(action: UndoAction): Promise<void>;
  /** Resolves false when there was nothing to undo. */
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  entries(): { label: string; at: number; done: boolean }[];
  clear(): void;
};

export declare function live(region: HTMLElement, options?: { stale?: number; age?: HTMLElement | null; hold?: boolean }): Destroyable & {
  update(apply: () => void, key?: string): void;
  flush(): void;
  beat(): void;
  offline(on?: boolean): void;
  readonly state: 'fresh' | 'stale' | 'offline';
  readonly held: boolean;
  readonly waiting: number;
};

// Data ----------------------------------------------------------------------------------------------------------------

export interface ChartSeries { label: string; values: (number | null)[]; code?: number; }
export interface ChartOptions {
  type?: 'line' | 'bars';
  labels: string[];
  series: ChartSeries[];
  unit?: string;
  min?: number;
  max?: number;
  height?: number;
  summary?: string;
  table?: boolean;
}
export declare function chart(el: HTMLElement, options: ChartOptions): Destroyable & {
  update(options: Partial<ChartOptions>): void;
  readonly active: number;
};

// Shell ---------------------------------------------------------------------------------------------------------------

export declare function icon(name: string, options?: { label?: string; src?: string }): SVGSVGElement;
export declare function titlebar(el: HTMLElement, options?: { router?: Router | null }): Destroyable;
export interface PwaState { supported: boolean; installed: boolean; canInstall: boolean; offlineReady: boolean; updateReady: boolean; }
export declare function pwa(options?: { sw?: string; toaster?: Toaster | null; onChange?: ((state: PwaState) => void) | null }): Destroyable & {
  readonly state: PwaState;
  /** Resolves true when the user accepted. */
  install(): Promise<boolean>;
  update(): void;
  check(): Promise<void>;
};

// Motion --------------------------------------------------------------------------------------------------------------

export declare function reflow<T>(scope: Element, change: () => T, options?: { items?: Element[] | null; size?: boolean }): Promise<T>;
export declare function enter(el: Element): Promise<void>;
export declare function leave(el: Element): Promise<Animation | null>;
export declare function presence(scope: Element, options: { items?: (() => Element[]) | Iterable<Element>; show: (item: Element) => boolean }): Promise<void>;
export declare function tileUpdate(tile: HTMLElement, change: () => void, options?: { kind?: 'peek' | 'flip' }): Promise<void>;
/** `points` as in the polyline's attribute ("0,4 10,2 20,6"). */
export declare function sparkTo(line: SVGPolylineElement, points: string): void;
export declare function crossfade(change: () => void): Promise<void>;
