import type { Action } from 'svelte/action';

/** Rekta's sideways-scroll breakpoint (`--rekta-breakpoint-sideways-scroll-min`): narrower screens only scroll down. */
export const SIDEWAYS_MIN_WIDTH = 760;

const DOM_DELTA_LINE = 1;
const LINE_HEIGHT_PX = 16;

export type Wheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey'>;

export type SidewaysScroller = {
	viewportWidth: number;
	scrollLeft: number;
	maxScrollLeft: number;
	/** A vertically scrollable box under the pointer can still move in the wheel's direction. */
	innerCanScroll: boolean;
};

// Trackpads and Shift report sideways movement themselves; turning that again would scroll twice. Ctrl is zoom.
const isPlainVerticalWheel = (wheel: Wheel) =>
	wheel.deltaX === 0 && wheel.deltaY !== 0 && !wheel.shiftKey && !wheel.ctrlKey;

/** The `scrollLeft` a vertical mouse wheel moves the scroller to, or null to leave the wheel to the browser. */
export function sidewaysTarget(wheel: Wheel, scroller: SidewaysScroller): number | null {
	if (!isPlainVerticalWheel(wheel)) return null;
	if (scroller.viewportWidth < SIDEWAYS_MIN_WIDTH || scroller.innerCanScroll) return null;
	const delta = wheel.deltaMode === DOM_DELTA_LINE ? wheel.deltaY * LINE_HEIGHT_PX : wheel.deltaY;
	const target = Math.min(scroller.maxScrollLeft, Math.max(0, scroller.scrollLeft + delta));
	// at either edge the wheel falls through to the page; scrollLeft may rest a fraction short of the edge
	return Math.abs(target - scroller.scrollLeft) < 1 ? null : target;
}

function canScrollVertically(element: Element, deltaY: number): boolean {
	if (!/auto|scroll/.test(getComputedStyle(element).overflowY)) return false;
	const room =
		deltaY > 0
			? element.scrollHeight - element.clientHeight - element.scrollTop
			: element.scrollTop;
	return room >= 1;
}

function innerScrollerCanMove(target: EventTarget | null, scroller: Element, deltaY: number) {
	const start = target instanceof Element ? target : null;
	for (let element = start; element && element !== scroller; element = element.parentElement) {
		if (canScrollVertically(element, deltaY)) return true;
	}
	return false;
}

/** On a desktop screen a vertical mouse wheel scrolls the element sideways, at once, as `sidewaysTarget` decides. */
export const sideways: Action<HTMLElement> = (node) => {
	function onWheel(event: WheelEvent) {
		const target = sidewaysTarget(event, {
			viewportWidth: innerWidth,
			scrollLeft: node.scrollLeft,
			maxScrollLeft: node.scrollWidth - node.clientWidth,
			innerCanScroll: innerScrollerCanMove(event.target, node, event.deltaY)
		});
		if (target === null) return;
		event.preventDefault();
		node.scrollTo({ left: target, behavior: 'instant' });
	}
	node.addEventListener('wheel', onWheel, { passive: false });
	return { destroy: () => node.removeEventListener('wheel', onWheel) };
};
