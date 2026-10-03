// Toast queue: toast('Gespeichert', 'success'). Call it in the browser only (module state is process-wide).
export type ToastTone = 'info' | 'success' | 'error';
/** A way out as a link (`{ label: 'Neu anmelden', href: '/login' }`) or a button that runs something (`Rückgängig`). */
export type ToastAction = { label: string; href: string } | { label: string; run: () => void };
export type Toast = { id: number; message: string; tone: ToastTone; action?: ToastAction };

export const toasts: Toast[] = $state([]);
let nextId = 1;

/** Errors stay until closed (default timeout 0); everything else disappears after 5 s. */
export function toast(
	message: string,
	tone: ToastTone = 'info',
	timeout = tone === 'error' ? 0 : 5000,
	action?: ToastAction
): number {
	const id = nextId++;
	toasts.push({ id, message, tone, action });
	if (timeout > 0) setTimeout(() => dismiss(id), timeout);
	return id;
}

export function dismiss(id: number): void {
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

/** The notice has done its job once its action runs. */
export function runAction({ id, action }: Toast): void {
	dismiss(id);
	if (action && 'run' in action) action.run();
}
