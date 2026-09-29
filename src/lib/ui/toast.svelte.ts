// Toast-Warteschlange: toast('Gespeichert', 'success'). Nur im Browser aufrufen (Modulzustand ist prozessweit).
export type ToastTone = 'info' | 'success' | 'error';
/** Optionaler Link als Ausweg, z. B. `{ label: 'Neu anmelden', href: '/login' }`. */
export type ToastAction = { label: string; href: string };
export type Toast = { id: number; message: string; tone: ToastTone; action?: ToastAction };

export const toasts: Toast[] = $state([]);
let nextId = 1;

/** Fehler bleiben, bis sie geschlossen werden (Standard-Timeout 0); alles andere verschwindet nach 5 s. */
export function toast(message: string, tone: ToastTone = 'info', timeout = tone === 'error' ? 0 : 5000, action?: ToastAction): number {
	const id = nextId++;
	toasts.push({ id, message, tone, action });
	if (timeout > 0) setTimeout(() => dismiss(id), timeout);
	return id;
}

export function dismiss(id: number): void {
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}
