import { toast } from '$lib/ui/toast.svelte';
import { invalidateLive, type HaltKind } from './live.svelte';

/** How the server refuses a run it cannot pause or resume. */
type Refusal = { code: string; message: string; hint: string };

const runs = (count: number) => (count === 1 ? 'Run' : 'Runs');

export const resumedText = (count: number) =>
	count === 1 ? '1 Run setzt fort.' : `${count} Runs setzen fort.`;

const RELEASED_TEXT: Record<HaltKind, string> = {
	stop: ' Not-Aus gelöst: wartende Runs starten wieder.',
	pause: ' Wartende Runs starten wieder.'
};

/** Calls a halt route; on a refusal or a broken connection a toast names the way out and nothing comes back. */
async function call<T>(method: 'POST' | 'DELETE', path: string, failure: string) {
	const response = await fetch(path, { method }).catch(() => undefined);
	if (response?.ok) return (await response.json()) as T;
	const refusal = response?.status === 400 ? ((await response.json()) as Refusal) : undefined;
	const wayOut = refusal
		? `${refusal.message} Ausweg: ${refusal.hint}`
		: `${failure} Verbindung prüfen und erneut versuchen.`;
	toast(wayOut, 'error');
}

/** Without waiting for the event, which a broken connection would lose. */
async function done(message: string) {
	toast(message, 'success');
	await invalidateLive();
}

export async function stopAll() {
	const answer = await call<{ cancelled: number }>('POST', '/api/halt', 'Stoppen ging nicht.');
	if (answer) await done(`Gestoppt: ${answer.cancelled} ${runs(answer.cancelled)} abgebrochen.`);
}

export async function pauseAll() {
	const answer = await call<{ paused: number }>('POST', '/api/pause', 'Anhalten ging nicht.');
	if (answer)
		await done(
			`Angehalten: ${answer.paused} ${runs(answer.paused)} pausiert. :fortsetzen all setzt fort.`
		);
}

export async function pauseRun(runId: number) {
	const path = `/api/runs/${runId}/pause`;
	if (await call('POST', path, 'Anhalten ging nicht.'))
		await done(`Run ${runId} angehalten. :fortsetzen setzt ihn fort.`);
}

export async function resumeRun(runId: number) {
	const path = `/api/runs/${runId}/resume`;
	if (await call('POST', path, 'Fortsetzen ging nicht.')) await done(resumedText(1));
}

/** `:fortsetzen all` and the head dock's „Fortsetzen“: every halted run resumes and the halt is lifted. */
export async function resumeAll() {
	const answer = await call<{ resumed: number; released: HaltKind | null }>(
		'DELETE',
		'/api/halt',
		'Fortsetzen ging nicht.'
	);
	if (answer)
		await done(
			resumedText(answer.resumed) + (answer.released ? RELEASED_TEXT[answer.released] : '')
		);
}
