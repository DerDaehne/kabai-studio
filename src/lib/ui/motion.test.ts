import { readFileSync } from 'node:fs';
import type { OnNavigate } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cubicBezier,
	duration,
	easing,
	motionMode,
	pivotGlideTarget,
	reducedCrossfadeMs,
	shift,
	spring,
	tilt,
	transitionPage,
	travel
} from './motion';

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
const navigation = (from: string, to: string) =>
	({
		complete: Promise.resolve(),
		from: { route: { id: from } },
		to: { route: { id: to } }
	}) as unknown as OnNavigate;
const startViewTransition = vi.fn((update: () => Promise<void>) => {
	const done = update();
	return { updateCallbackDone: done, ready: done, finished: done };
});
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
	['the user chose reduced motion', () => (dataset.motion = 'off')]
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
		expect(transitionPage(navigation('/', '/settings'))).toBeUndefined();
		expect(startViewTransition).not.toHaveBeenCalled();
	});
});

describe('with full motion', () => {
	it('travel moves along the offset while fading', () => {
		expect(travel(node, { x: 10, y: 20 }).css?.(0.5, 0.5)).toBe(
			'opacity: 0.5; transform: translate(5px, 10px)'
		);
	});

	it('tilt turns the leaving card away to the left and brings the next one in from the right', () => {
		expect(tilt(node, {}, { direction: 'out' }).css?.(0, 1)).toContain(
			'translateX(-40px) rotateY(12deg)'
		);
		expect(tilt(node, {}, { direction: 'in' }).css?.(0, 1)).toContain(
			'translateX(40px) rotateY(-12deg)'
		);
	});

	it('runs page swaps inside a view transition and resolves once the transition has started', async () => {
		await transitionPage(navigation('/', '/settings'));
		expect(startViewTransition).toHaveBeenCalledOnce();
	});

	it('takes a transition that a newer navigation aborts or skips in its stride, with no unhandled rejection', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		const aborted = { ...navigation('/', '/takt'), complete: Promise.reject(new Error('aborted')) };
		const skipped = () => Promise.reject(new DOMException('Transition was skipped', 'AbortError'));
		startViewTransition.mockImplementationOnce((update) => {
			void update().catch(() => {});
			return { updateCallbackDone: skipped(), ready: skipped(), finished: skipped() };
		});

		await transitionPage(aborted as OnNavigate);
		await new Promise((resolve) => setTimeout(resolve, 10));
		process.off('unhandledRejection', unhandled);
		expect(unhandled).not.toHaveBeenCalled();
	});

	it('keeps parameter changes within the same route free of page transitions', () => {
		expect(transitionPage(navigation('/projects/[id]', '/projects/[id]'))).toBeUndefined();
		expect(startViewTransition).not.toHaveBeenCalled();
	});
});

describe('motion values', () => {
	const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
	const token = (name: string) => tokens.match(new RegExp(`${name}: ([^;]+);`))?.[1];

	it('match the duration and distance tokens', () => {
		for (const [name, ms] of Object.entries(duration))
			expect(token(`--dur-${name}`)).toBe(`${ms}ms`);
		for (const [name, px] of Object.entries(shift))
			expect(token(`--shift-${name}`)).toBe(`${px}px`);
	});

	it('sample the spring easing exactly like the --ease-spring token', () => {
		const samples = Array.from({ length: 21 }, (_, i) => Number(spring(i / 20).toFixed(3)));
		expect(token('--ease-spring')).toBe(`linear(${samples.join(', ')})`);
	});

	it('let the spring overshoot once and come to rest at 1', () => {
		expect(Math.max(...Array.from({ length: 101 }, (_, i) => spring(i / 100)))).toBeCloseTo(
			1.046,
			2
		);
		expect(spring(1)).toBe(1);
	});
});

describe('easing.out', () => {
	it("is the curve of Rekta's --rk-ease-out token", () => {
		const tokens = readFileSync(new URL('../styles/rekta.tokens.css', import.meta.url), 'utf8');
		const [x1, y1, x2, y2] = tokens
			.match(/--rk-ease-out: cubic-bezier\(([^)]+)\)/)![1]
			.split(',')
			.map(Number);
		const rekta = cubicBezier(x1, y1, x2, y2);
		for (const progress of [0, 0.25, 0.5, 0.75, 1])
			expect(easing.out(progress)).toBeCloseTo(rekta(progress), 6);
	});

	it('starts at 0, ends at 1 and rises in between', () => {
		expect([easing.out(0), easing.out(1)]).toEqual([0, 1]);
		expect(easing.out(0.5)).toBeGreaterThan(easing.out(0.25));
	});
});

describe('pivotGlideTarget', () => {
	const gap = 10;
	// five titles, the active one drawn 100 wide, the others 50; the titles may fill 200
	const strip = (active: number) => [50, 50, 50, 50, 50].map((w, i) => (i === active ? 100 : w));
	const lefts = (widths: number[]) =>
		widths.map((_, i) => widths.slice(0, i).reduce((x, w) => x + w + gap, 0));

	it('holds a strip that fits still, whichever title is active', () => {
		for (let active = 0; active < 3; active++)
			expect(pivotGlideTarget([40, 40, 40], active, gap, 200)).toBe(0);
	});

	it('shows the start for the first title and the end for the last', () => {
		const first = strip(0);
		const last = strip(4);
		expect(pivotGlideTarget(first, 0, gap, 200)).toBe(0);
		const total = lefts(last)[4] + last[4];
		expect(pivotGlideTarget(last, 4, gap, 200)).toBe(total - 200);
	});

	it('keeps the active title whole and the one before it inside the edge, for every title', () => {
		for (let active = 0; active < 5; active++) {
			const widths = strip(active);
			const x = lefts(widths);
			const to = pivotGlideTarget(widths, active, gap, 200);
			expect(x[active] + widths[active] - to, `title ${active} whole`).toBeLessThanOrEqual(200);
			expect(x[active] - to, `title ${active} not cut at the left`).toBeGreaterThanOrEqual(0);
			if (active > 0)
				expect(x[active - 1] - to, `predecessor of ${active}`).toBeGreaterThanOrEqual(0);
		}
	});

	it('moves on with the place in the order, never back', () => {
		const targets = [0, 1, 2, 3, 4].map((i) => pivotGlideTarget(strip(i), i, gap, 200));
		expect(targets).toEqual([...targets].sort((a, b) => a - b));
		expect(new Set(targets).size).toBeGreaterThan(2);
	});
});
