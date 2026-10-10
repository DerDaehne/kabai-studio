import { describe, expect, it } from 'vitest';
import { SIDEWAYS_MIN_WIDTH, sidewaysTarget, type SidewaysScroller, type Wheel } from './sideways';

const mouseWheel = (deltaY: number, more: Partial<Wheel> = {}): Wheel => ({
	deltaX: 0,
	deltaY,
	deltaMode: 0,
	shiftKey: false,
	ctrlKey: false,
	...more
});

const desktop = (more: Partial<SidewaysScroller> = {}): SidewaysScroller => ({
	viewportWidth: 1440,
	scrollLeft: 200,
	maxScrollLeft: 1000,
	innerCanScroll: false,
	...more
});

describe('sidewaysTarget', () => {
	it('turns a vertical mouse wheel into the same distance sideways, in both directions', () => {
		expect(sidewaysTarget(mouseWheel(300), desktop())).toBe(500);
		expect(sidewaysTarget(mouseWheel(-100), desktop())).toBe(100);
	});

	it('reads a wheel that counts in lines as 16 px per line', () => {
		expect(sidewaysTarget(mouseWheel(3, { deltaMode: 1 }), desktop())).toBe(248);
	});

	it('leaves a trackpad or a Shift-wheel to the browser, so nothing scrolls twice', () => {
		expect(sidewaysTarget(mouseWheel(300, { deltaX: 40 }), desktop())).toBeNull();
		expect(sidewaysTarget(mouseWheel(0, { deltaX: 100 }), desktop())).toBeNull();
		expect(sidewaysTarget(mouseWheel(300, { shiftKey: true }), desktop())).toBeNull();
	});

	it('leaves Ctrl+wheel to the browser, which zooms with it', () => {
		expect(sidewaysTarget(mouseWheel(300, { ctrlKey: true }), desktop())).toBeNull();
	});

	it('changes nothing below the sideways breakpoint: phones only scroll down', () => {
		const phone = desktop({ viewportWidth: SIDEWAYS_MIN_WIDTH - 1 });
		expect(sidewaysTarget(mouseWheel(300), phone)).toBeNull();
		const narrowestDesktop = desktop({ viewportWidth: SIDEWAYS_MIN_WIDTH });
		expect(sidewaysTarget(mouseWheel(300), narrowestDesktop)).toBe(500);
	});

	it('lets an inner vertical scroller that can still move keep the wheel', () => {
		expect(sidewaysTarget(mouseWheel(300), desktop({ innerCanScroll: true }))).toBeNull();
	});

	it('stops at either edge and lets the wheel fall through to the page once there', () => {
		expect(sidewaysTarget(mouseWheel(300), desktop({ scrollLeft: 900 }))).toBe(1000);
		expect(sidewaysTarget(mouseWheel(300), desktop({ scrollLeft: 1000 }))).toBeNull();
		expect(sidewaysTarget(mouseWheel(-300), desktop({ scrollLeft: 0 }))).toBeNull();
	});

	it('treats a scroll position a fraction short of the edge as the edge', () => {
		expect(sidewaysTarget(mouseWheel(300), desktop({ scrollLeft: 999.5 }))).toBeNull();
	});

	it('lets the wheel through when there is nothing to scroll sideways', () => {
		expect(
			sidewaysTarget(mouseWheel(300), desktop({ scrollLeft: 0, maxScrollLeft: 0 }))
		).toBeNull();
	});
});
