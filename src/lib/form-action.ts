import type { ActionResult } from '@sveltejs/kit';
import { deserialize } from '$app/forms';

/** Calls a form action (`/takt?/answer`) from a key press, the same way a submitted form would. */
export async function postAction(
	url: string,
	fields: Record<string, string>
): Promise<ActionResult> {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	try {
		const headers = { 'x-sveltekit-action': 'true' };
		const response = await fetch(url, { method: 'POST', body, headers });
		return deserialize(await response.text());
	} catch (error) {
		return { type: 'error', error };
	}
}

/** The message of a refused or failed action, with its way out; undefined when it succeeded. */
export function failureOf(result: ActionResult): string | undefined {
	if (result.type === 'success') return undefined;
	if (result.type === 'failure') return String(result.data?.message);
	return 'Das hat nicht geklappt. Lade die Seite neu und versuch es noch einmal.';
}
