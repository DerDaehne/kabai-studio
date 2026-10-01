import { readFileSync } from 'node:fs';
import type { OnNavigate } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { duration, motionMode, reducedCrossfadeMs, shift, spring, tilt, transitionPage, travel } from './motion';

const system = vi.hoisted(() => ({ prefersReducedMotion: false }));
vi.mock('svelte/motion', () => ({
	prefersReducedMotion: {
		get current() {
			return system.prefersReducedMotion;
		}
	}
}));

const node = {} as Element;
const transitions = {
	travel: () => travel(node, { y: shift.lg, delay: 80 }),
	'tilt in': () => tilt(node, {}, { direction: 'in' }),
	'tilt out': () => tilt(node, { reverse: true }, { direction: 'out' })
};
const startViewTransition = vi.fn((update: () => Promise<void>) => void update());
const dataset: DOMStringMap = {};

beforeEach(() => {
	system.prefersReducedMotion = false;
	delete dataset.motion;
	startViewTransition.mockClear();
	vi.stubGlobal('document', { documentElement: { dataset }, startViewTransition });
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
	['the system prefers reduced motion', () => (system.prefersReducedMotion = true)],
	['the user chose reduced motion', () => (dataset.motion = 'reduced')]
])('when %s', (_, reduce) => {
	beforeEach(reduce);

	it('reports reduced motion', () => {
		expect(motionMode()).toBe('reduced');
	});

	it.each(Object.entries(transitions))('%s only crossfades, within 120 ms', (_, transition) => {
		const config = transition();
		expect((config.delay ?? 0) + (config.duration ?? 0)).toBeLessThanOrEqual(reducedCrossfadeMs);
		expect(config.css?.(0.4, 0.6)).toBe('opacity: 0.4');
	});

	it('swaps pages without a view transition', () => {
		expect(transitionPage({ complete: Promise.resolve() } as OnNavigate)).toBeUndefined();
		expect(startViewTransition).not.toHaveBeenCalled();
	});
});

describe('with full motion', () => {
	it('travel moves along the offset while fading', () => {
		expect(travel(node, { x: 10, y: 20 }).css?.(0.5, 0.5)).toBe('opacity: 0.5; transform: translate(5px, 10px)');
	});

	it('tilt turns the leaving card away to the left and brings the next one in from the right', () => {
		expect(tilt(node, {}, { direction: 'out' }).css?.(0, 1)).toContain('translateX(-40px) rotateY(12deg)');
		expect(tilt(node, {}, { direction: 'in' }).css?.(0, 1)).toContain('translateX(40px) rotateY(-12deg)');
	});

	it('runs page swaps inside a view transition and resolves once the transition has started', async () => {
		await transitionPage({ complete: Promise.resolve() } as OnNavigate);
		expect(startViewTransition).toHaveBeenCalledOnce();
	});
});

describe('motion values', () => {
	const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
	const token = (name: string) => tokens.match(new RegExp(`${name}: ([^;]+);`))?.[1];

	it('match the duration and distance tokens', () => {
		for (const [name, ms] of Object.entries(duration)) expect(token(`--dur-${name}`)).toBe(`${ms}ms`);
		for (const [name, px] of Object.entries(shift)) expect(token(`--shift-${name}`)).toBe(`${px}px`);
	});

	it('sample the spring easing exactly like the --ease-spring token', () => {
		const samples = Array.from({ length: 21 }, (_, i) => Number(spring(i / 20).toFixed(3)));
		expect(token('--ease-spring')).toBe(`linear(${samples.join(', ')})`);
	});

	it('let the spring overshoot once and come to rest at 1', () => {
		expect(Math.max(...Array.from({ length: 101 }, (_, i) => spring(i / 100)))).toBeCloseTo(1.046, 2);
		expect(spring(1)).toBe(1);
	});
});
