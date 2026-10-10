import type { HaltKind, LiveRun } from '$lib/live';
import { toast } from '$lib/ui/toast.svelte';
import { invalidateLive } from './live.svelte';

/** How the server refuses a run it cannot pause or resume. */
type Refusal = { code: string; message: string; hint: string };
/** A halted run `:fortsetzen all` could not resume, e.g. because its profile is gone. */
type SkippedResume = Refusal & { runId: number };

const runs = (count: number) => (count === 1 ? 'Run' : 'Runs');

export const resumedText = (count: number) =>
	count === 1 ? '1 Run setzt fort.' : `${count} Runs setzen fort.`;

const RELEASED_TEXT: Record<HaltKind, string> = {
	stop: ' Not-Aus gelöst: wartende Runs starten wieder.',
	pause: ' Wartende Runs starten wieder.'
};

const countOf = (allRuns: LiveRun[], state: LiveRun['state']) =>
	allRuns.filter((run) => run.state === state).length;

/** The halt banner's text while a halt is set: a stop counts the waiting runs, a pause the runs it paused. */
export const haltLabel = (halt: HaltKind, allRuns: LiveRun[]) =>
	halt === 'stop'
		? `Gestoppt · ${countOf(allRuns, 'queued')} wartend`
		: `Angehalten · ${countOf(allRuns, 'paused')} pausiert`;

const QUEUE_WAITS = 'Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen all).';

function activeRunsText(count: number, what: string) {
	if (count === 0) return 'Gerade läuft kein Run.';
	if (count === 1) return `1 Run läuft und wird sofort ${what}.`;
	return `${count} Runs laufen und werden sofort ${what}.`;
}

/** The confirmation before `:stop`: what gets cancelled and how the queue goes on. */
export const stopQuestion = (activeRuns: number) =>
	`${activeRunsText(activeRuns, 'abgebrochen')} ${QUEUE_WAITS}`;

/** The confirmation before a global `:anhalten`: what gets paused, what is lost and how everything goes on. */
export const pauseQuestion = (activeRuns: number) =>
	`${activeRunsText(activeRuns, 'angehalten')}${activeRuns ? ' Der angefangene Schritt wird verworfen, :fortsetzen all setzt die Arbeit fort.' : ''} ${QUEUE_WAITS}`;

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
async function done(message: string, tone: 'success' | 'error' = 'success') {
	toast(message, tone);
	await invalidateLive();
}

const skippedText = (skipped: SkippedResume[]) =>
	skipped
		.map((run) => ` Run ${run.runId} übersprungen: ${run.message} Ausweg: ${run.hint}`)
		.join('');

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

/**
 * `:fortsetzen all` and the halt banner's „Fortsetzen“: every halted run resumes and the halt is lifted; a run that
 * could not resume is named with its way out, so the human knows exactly which run still needs attention.
 */
export async function resumeAll() {
	const answer = await call<{
		resumed: number;
		released: HaltKind | null;
		skipped: SkippedResume[];
	}>('DELETE', '/api/halt', 'Fortsetzen ging nicht.');
	if (!answer) return;
	const message =
		resumedText(answer.resumed) +
		(answer.released ? RELEASED_TEXT[answer.released] : '') +
		skippedText(answer.skipped);
	await done(message, answer.skipped.length ? 'error' : 'success');
}
