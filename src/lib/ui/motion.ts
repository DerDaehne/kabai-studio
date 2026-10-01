import type { OnNavigate } from '@sveltejs/kit';
import { circIn, cubicInOut, expoOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import type { TransitionConfig } from 'svelte/transition';

/** Durations in milliseconds, the same values as the --dur-* tokens. */
export const duration = { micro: 90, fast: 140, base: 220, slow: 320, glide: 380, pulse: 1600, sweep: 1400 } as const;

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
	return 1 - decay * (Math.cos(phase) + (springDamping / Math.sqrt(1 - springDamping ** 2)) * Math.sin(phase));
}

/** Script counterparts of --ease-out, --ease-in, --ease-inout and --ease-spring. */
export const easing = { out: expoOut, in: circIn, inOut: cubicInOut, spring } as const;

export type MotionMode = 'full' | 'reduced';

/** Reduced when the system asks for it or the user chose it in the app (data-motion on the root element). */
export function motionMode(): MotionMode {
	const userPrefersReduced = typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced';
	return prefersReducedMotion.current || userPrefersReduced ? 'reduced' : 'full';
}

function crossfade(): TransitionConfig {
	return { duration: reducedCrossfadeMs, css: (t) => `opacity: ${t}` };
}

/** Enters from, or leaves towards, a short offset. Reduced motion only crossfades. */
export function travel(_node: Element, { x = 0, y = shift.md, delay = 0 }: { x?: number; y?: number; delay?: number } = {}): TransitionConfig {
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

/** For onNavigate: swaps pages inside a view transition. Skipped with reduced motion or without browser support. */
export function transitionPage(navigation: OnNavigate): Promise<void> | undefined {
	if (!document.startViewTransition || motionMode() === 'reduced') return;
	return new Promise((resolve) => {
		document.startViewTransition(async () => {
			resolve();
			await navigation.complete;
		});
	});
}
