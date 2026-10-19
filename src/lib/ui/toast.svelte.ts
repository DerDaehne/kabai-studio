import { connection } from '$lib/shell/connection.svelte';
import { tokenMs } from './motion';

// Toast: toast('Gespeichert', 'success'). Call it in the browser only (module state is process-wide).
export type ToastTone = 'info' | 'success' | 'error';
/** What the server answers to one beat of a hold. */
export type HoldBeat = { held: boolean; closesInMs: number; capped: boolean };
/**
 * While the toast is held, the window it guards is kept open by beats: a beat that gets no confirmation ends the hold.
 * The server's remaining time replaces the local one, so toast and server count the same clock.
 */
export type HoldLease = {
	beatMs: number;
	/** Resolves with the server's answer, or undefined when it could not be reached. */
	beat: () => Promise<HoldBeat | undefined>;
	/** The text once holding no longer extends the window; it is announced once. */
	cappedMessage: (secondsLeft: number) => string;
};
/** A way out as a button. With `countdown` it takes something back, and its window closes in view. */
export type ToastAction = {
	label: string;
	run: () => void;
	countdown?: boolean;
	/** Runs when the window closes unused, so what the window guarded can be settled after a held toast too. */
	onExpire?: () => void;
	hold?: HoldLease;
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
/** Shorter than the beat interval, so a silent server ends the hold before the next beat is due. */
export const BEAT_TIMEOUT_MS = 4000;

/** At most one: a new toast replaces the open one. */
export const toasts: Toast[] = $state([]);
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const holds = new Set<HoldReason>();
let beatTimer: ReturnType<typeof setInterval> | undefined;
/** Once a lease toast's hold has ended (unconfirmed beat, cap, nothing to hold) it counts down again for good. */
let holdEnded = false;
let confirmed = { left: 0, at: 0 };
/** When the open toast runs out on the wall clock; unset while it stands still. Ticks only show it, they never count. */
let endsAt: number | undefined;

/** How long a toast stays: Rekta's `--rk-duration-toast`, which the product sets. */
export const toastMs = () => tokenMs('--rk-duration-toast');

const stands = (open: Toast) => holds.size > 0 && !(open.action?.hold && holdEnded);

/** Whether the open toast stands still because the pointer or focus is on it. */
export const isHeld = () => !!toasts[0] && stands(toasts[0]);

function expire(open: Toast) {
	dismiss(open.id);
	open.action?.onExpire?.();
}

/** The server-confirmed end of the window. */
function continueFromConfirmed(open: Toast) {
	endsAt = confirmed.at + confirmed.left;
	showTimeLeft(open);
}

/** A tick that comes late (stalled main thread, throttled tab) finds the time up and closes the toast at once. */
function showTimeLeft(open: Toast) {
	open.left = Math.max(0, endsAt! - Date.now());
	if (open.left <= 0) expire(open);
	else schedule();
}

function schedule() {
	clearTimeout(timer);
	timer = undefined;
	const [open] = toasts;
	if (!open || open.left <= 0) return;
	if (stands(open)) {
		endsAt = undefined;
		return;
	}
	endsAt ??= Date.now() + open.left;
	timer = setTimeout(() => showTimeLeft(open), (endsAt - Date.now()) % STEP_MS || STEP_MS);
}

/** Holding freezes what is left; letting go ends the window at a new time. */
function freezeTimeLeft(open: Toast) {
	if (endsAt !== undefined) showTimeLeft(open);
	endsAt = undefined;
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
	stopBeating();
	holdEnded = false;
	endsAt = undefined;
	toasts.splice(0, toasts.length, { id, message, tone, action, left: timeout, windowMs: timeout });
	schedule();
	return id;
}

export function dismiss(id: number): void {
	const i = toasts.findIndex((t) => t.id === id);
	if (i === -1) return;
	if (i === 0) {
		stopBeating();
		endsAt = undefined;
	}
	toasts.splice(i, 1);
	schedule();
}

/** The window stands still while the pointer rests on the toast or focus is in it; each reason counts on its own. */
export function hold(reason: HoldReason, value: boolean): void {
	const wasHeld = holds.size > 0;
	if (value) holds.add(reason);
	else holds.delete(reason);
	const [open] = toasts;
	if (open && value && !wasHeld) freezeTimeLeft(open);
	if (open?.action?.hold && !holdEnded) leaseFollowsHolds(open, wasHeld);
	schedule();
}

function leaseFollowsHolds(open: Toast, wasHeld: boolean) {
	if (holds.size && !wasHeld) startBeating(open, open.action!.hold!);
	if (!holds.size && wasHeld) {
		stopBeating();
		continueFromConfirmed(open);
	}
}

function startBeating(open: Toast, lease: HoldLease) {
	confirmed = { left: open.left, at: Date.now() };
	if (connection.lost) return endHold(open);
	let inFlight = false;
	const send = async () => {
		if (inFlight) return;
		inFlight = true;
		try {
			await beat(open, lease);
		} finally {
			inFlight = false;
		}
	};
	void send();
	beatTimer = setInterval(() => void send(), lease.beatMs);
}

function stopBeating() {
	clearInterval(beatTimer);
	beatTimer = undefined;
}

async function beat(open: Toast, lease: HoldLease) {
	const sentAt = Date.now();
	const confirmedLeft = confirmed.left - (sentAt - confirmed.at);
	const patience = Math.min(BEAT_TIMEOUT_MS, Math.max(0, confirmedLeft));
	const silence = new Promise<undefined>((resolve) => setTimeout(resolve, patience));
	const answer = await Promise.race([lease.beat().catch(() => undefined), silence]);
	if (toasts[0] !== open || holdEnded) return;
	if (!answer || connection.lost || (!answer.held && !answer.capped)) return endHold(open);
	confirmed = { left: answer.closesInMs, at: sentAt };
	if (answer.capped) return endHold(open, lease.cappedMessage(Math.ceil(answer.closesInMs / 1000)));
	open.left = answer.closesInMs;
	endsAt = holds.size ? undefined : sentAt + answer.closesInMs;
}

/** The hold ends for good: the toast runs down from the last time the server confirmed. */
function endHold(open: Toast, message?: string) {
	holdEnded = true;
	stopBeating();
	if (message) open.message = message;
	continueFromConfirmed(open);
}

/** The connection is gone: a held toast stops waiting for beats and runs down at once. */
export function connectionLost(): void {
	const [open] = toasts;
	if (open?.action?.hold && holds.size && !holdEnded) endHold(open);
}

/** The notice has done its job once its action runs. */
export function runAction({ id, action }: Toast): void {
	dismiss(id);
	action?.run();
}
