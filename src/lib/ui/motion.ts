import type { OnNavigate } from '@sveltejs/kit';
import { circIn, cubicInOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import type { TransitionConfig } from 'svelte/transition';

/** Durations in milliseconds, the same values as the --dur-* tokens. */
export const duration = {
	micro: 90,
	fast: 140,
	base: 220,
	slow: 320,
	glide: 380,
	pulse: 1600,
	sweep: 1400
} as const;

/** Distances in pixels, the same values as the --shift-* tokens. */
export const shift = { sm: 6, md: 14, lg: 32 } as const;

/** Upper bound for any transition under reduced motion: a plain crossfade, no movement. */
export const reducedCrossfadeMs = 120;

const springDamping = 0.7;
const springFrequency = 8.5;

/** Underdamped spring from 0 to 1 over t in [0, 1]: overshoots by about 4.6 % at t = 0.5, then settles. */
export function spring(t: number): number {
	if (t >= 1) return 1;
	const dampedFrequency = springFrequency * Math.sqrt(1 - springDamping ** 2);
	const decay = Math.exp(-springDamping * springFrequency * t);
	const phase = dampedFrequency * t;
	return (
		1 -
		decay *
			(Math.cos(phase) + (springDamping / Math.sqrt(1 - springDamping ** 2)) * Math.sin(phase))
	);
}

/** Script counterparts of --ease-out, --ease-in, --ease-inout and --ease-spring. */
export const easing = {
	out: cubicBezier(0.4, 0, 0.5, 1),
	in: circIn,
	inOut: cubicInOut,
	spring
} as const;

export type MotionMode = 'full' | 'reduced';

/** Reduced when the system asks for it or the user chose it in the app (data-motion on the root element). */
export function motionMode(): MotionMode {
	const userPrefersReduced =
		typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off';
	return prefersReducedMotion.current || userPrefersReduced ? 'reduced' : 'full';
}

function crossfade(): TransitionConfig {
	return { duration: reducedCrossfadeMs, css: (t) => `opacity: ${t}` };
}

/** Enters from, or leaves towards, a short offset. Reduced motion only crossfades. */
export function travel(
	_node: Element,
	{ x = 0, y = shift.md, delay = 0 }: { x?: number; y?: number; delay?: number } = {}
): TransitionConfig {
	if (motionMode() === 'reduced') return crossfade();
	return {
		delay,
		duration: duration.base,
		easing: easing.out,
		css: (t, u) => `opacity: ${t}; transform: translate(${u * x}px, ${u * y}px)`
	};
}

const tiltDegrees = 12;
const tiltOffset = 40;

/**
 * Card advance with a 3D tilt: the leaving card turns away to the left, the next one turns in from the right;
 * `reverse` mirrors both for undo. Only with full motion, otherwise a crossfade.
 */
export function tilt(
	_node: Element,
	{ reverse = false }: { reverse?: boolean } = {},
	{ direction }: { direction: 'in' | 'out' | 'both' } = { direction: 'both' }
): TransitionConfig {
	if (motionMode() === 'reduced') return crossfade();
	const side = (direction === 'out' ? -1 : 1) * (reverse ? -1 : 1);
	return {
		duration: duration.slow,
		easing: easing.out,
		css: (t, u) =>
			`opacity: ${t}; transform: perspective(900px) translateX(${u * tiltOffset * side}px) rotateY(${-u * tiltDegrees * side}deg) scale(${1 - u * 0.03})`
	};
}

const ignore = () => {};

/**
 * For onNavigate: a change of place turns the page like a turnstile inside a view transition (keyframes in base.css).
 * Skipped within the same route (only parameters change), with reduced motion and without browser support.
 */
export function transitionPage(navigation: OnNavigate): Promise<void> | undefined {
	const samePage = navigation.from?.route.id === navigation.to?.route.id;
	if (samePage || !document.startViewTransition || motionMode() === 'reduced') return;
	return new Promise((resolve) => {
		const transition = document.startViewTransition(async () => {
			resolve();
			await navigation.complete;
		});
		// A newer navigation aborts this one and skips its transition: the normal case while clicking on, not an error.
		for (const step of [transition.updateCallbackDone, transition.ready, transition.finished])
			step.catch(ignore);
	});
}

/** A duration token such as `--motion-moderate` in milliseconds, as the stylesheets resolve it right now. */
export function tokenMs(name: string): number {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000 || 0;
}

type Ease = (progress: number) => number;

/** The timing function of a CSS `cubic-bezier(x1, y1, x2, y2)`, solved for x by Newton's method like a browser does. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
	const coefficient = (a: number, b: number) => [1 - 3 * b + 3 * a, 3 * b - 6 * a, 3 * a] as const;
	const [ax, bx, cx] = coefficient(x1, x2);
	const [ay, by, cy] = coefficient(y1, y2);
	const curve = (a: number, b: number, c: number, t: number) => ((a * t + b) * t + c) * t;
	return (x) => {
		let t = x;
		for (let step = 0; step < 8; step++) {
			const error = curve(ax, bx, cx, t) - x;
			const slope = (3 * ax * t + 2 * bx) * t + cx;
			if (Math.abs(error) < 1e-4 || Math.abs(slope) < 1e-6) break;
			t -= error / slope;
		}
		return curve(ay, by, cy, Math.min(1, Math.max(0, t)));
	};
}

/** The easing token `--ease-pivot-glide` as a function; the in-out ease of the same shape if it is not a cubic-bezier. */
function pivotGlideEase(): Ease {
	const token = getComputedStyle(document.documentElement).getPropertyValue('--ease-pivot-glide');
	const numbers = /cubic-bezier\(([^)]+)\)/.exec(token)?.[1].split(',').map(Number);
	return numbers?.length === 4
		? cubicBezier(...(numbers as [number, number, number, number]))
		: easing.inOut;
}

const glides = new WeakMap<HTMLElement, number>();

/**
 * Scrolls `element` sideways to `left` with `ease` over `durationMs`; at once for 0, which is what the duration
 * tokens become under reduced motion. Each frame scrolls instantly so CSS smooth scrolling cannot fight the easing.
 */
export function glideScrollLeft(
	element: HTMLElement,
	left: number,
	durationMs: number,
	ease: Ease = easing.inOut
): void {
	const from = element.scrollLeft;
	const started = performance.now();
	const frame = (now: number) => {
		const progress = durationMs > 0 ? Math.min(1, (now - started) / durationMs) : 1;
		element.scrollTo({ left: from + (left - from) * ease(progress), behavior: 'instant' });
		if (progress < 1) glides.set(element, requestAnimationFrame(frame));
	};
	cancelAnimationFrame(glides.get(element) ?? 0);
	frame(started);
}

/** Glides a pivot's row or panorama to `left` with the duration and curve of the pivot glide tokens. */
export function glidePivot(element: HTMLElement, left: number, jump: boolean): void {
	glideScrollLeft(element, left, jump ? 0 : tokenMs('--motion-pivot-glide'), pivotGlideEase());
}

/**
 * Where a strip of titles scrolls to so that it glides by the active title's place in the fixed order: the first title
 * shows the start, the last the end, those between move it in proportion. The titles before the active one stay in
 * reach (the one just before starts inside the edge), the active one is always whole, and a strip that fits holds still.
 * `widths` are the drawn widths, the active one at its large size; `room` is the width the titles may fill.
 */
export function pivotGlideTarget(
	widths: number[],
	active: number,
	gap: number,
	room: number
): number {
	const lefts = widths.map((_, index) => widths.slice(0, index).reduce((x, w) => x + w + gap, 0));
	const total = lefts[lefts.length - 1] + widths[widths.length - 1];
	const farthest = Math.max(0, total - room);
	const proportional = widths.length > 1 ? (farthest * active) / (widths.length - 1) : 0;
	const reachBack = active > 0 ? lefts[active - 1] : lefts[active];
	const activeWhole = lefts[active] + widths[active] - room;
	return Math.min(farthest, Math.max(0, activeWhole, Math.min(proportional, reachBack)));
}

/**
 * Titles are laid out at the small size; the active one scales up by the ratio of the row's font size to its own and
 * the titles after it move aside by the room it takes, so only transforms change and the row keeps its height.
 */
function makeRoomForActive(row: HTMLElement, active: HTMLElement | null) {
	const small = active ?? (row.firstElementChild as HTMLElement);
	const scale =
		parseFloat(getComputedStyle(row).fontSize) / parseFloat(getComputedStyle(small).fontSize);
	row.style.setProperty('--active-scale', String(scale));
	row.style.setProperty('--active-room', `${active ? active.offsetWidth * (scale - 1) : 0}px`);
	return scale;
}

/** Glides a pivot's title row by the place of the active title (see `pivotGlideTarget`), at once if `jump`. */
export function revealActiveTitle(row: HTMLElement, active: HTMLElement | null, jump: boolean) {
	const scale = makeRoomForActive(row, active);
	const titles = [...row.children] as HTMLElement[];
	const style = getComputedStyle(row);
	const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
	const widths = titles.map((title) => title.offsetWidth * (title === active ? scale : 1));
	const left = active
		? pivotGlideTarget(
				widths,
				titles.indexOf(active),
				parseFloat(style.columnGap) || 0,
				row.clientWidth - padding
			)
		: 0;
	glidePivot(row, left, jump);
}
