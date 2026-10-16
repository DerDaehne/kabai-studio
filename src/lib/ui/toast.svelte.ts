import { tokenMs } from './motion';

// Toast: toast('Gespeichert', 'success'). Call it in the browser only (module state is process-wide).
export type ToastTone = 'info' | 'success' | 'error';
/** A way out as a button. With `countdown` it takes something back, and its window closes in view. */
export type ToastAction = {
	label: string;
	run: () => void;
	countdown?: boolean;
	/** Runs when the window closes unused, so what the window guarded can be settled after a held toast too. */
	onExpire?: () => void;
};
export type Toast = {
	id: number;
	message: string;
	tone: ToastTone;
	action?: ToastAction;
	/** Milliseconds until it goes. */
	left: number;
	/** The whole window, fixed at creation: what a screen reader announces must not tick. */
	windowMs: number;
};
export type HoldReason = 'pointer' | 'focus';

const STEP_MS = 1000;

/** At most one: a new toast replaces the open one. */
export const toasts: Toast[] = $state([]);
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const holds = new Set<HoldReason>();

/** How long a toast stays: Rekta's `--rk-duration-toast`, which the product sets. */
export const toastMs = () => tokenMs('--rk-duration-toast');

/** Whether the open toast stands still because the pointer or focus is on it. */
export const isHeld = () => holds.size > 0;

function schedule() {
	clearTimeout(timer);
	timer = undefined;
	const [open] = toasts;
	if (!open || open.left <= 0 || holds.size) return;
	const step = Math.min(STEP_MS, open.left);
	timer = setTimeout(() => {
		open.left -= step;
		if (open.left <= 0) {
			dismiss(open.id);
			open.action?.onExpire?.();
		} else schedule();
	}, step);
}

/** Every toast goes after `timeout`, errors too: what has to stay belongs in the banner or at the field. */
export function toast(
	message: string,
	tone: ToastTone = 'info',
	timeout = toastMs(),
	action?: ToastAction
): number {
	const id = nextId++;
	holds.clear();
	toasts.splice(0, toasts.length, { id, message, tone, action, left: timeout, windowMs: timeout });
	schedule();
	return id;
}

export function dismiss(id: number): void {
	const i = toasts.findIndex((t) => t.id === id);
	if (i === -1) return;
	toasts.splice(i, 1);
	schedule();
}

/** The window stands still while the pointer rests on the toast or focus is in it; each reason counts on its own. */
export function hold(reason: HoldReason, value: boolean): void {
	if (value) holds.add(reason);
	else holds.delete(reason);
	schedule();
}

/** The notice has done its job once its action runs. */
export function runAction({ id, action }: Toast): void {
	dismiss(id);
	action?.run();
}
