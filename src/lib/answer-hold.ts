import { postAction } from '$lib/form-action';
import { t } from '$lib/i18n/t';
import type { HoldBeat, HoldLease } from '$lib/ui/toast.svelte';

async function beatFor(questionId: number): Promise<HoldBeat | undefined> {
	const result = await postAction('/takt?/hold', { question: String(questionId) });
	if (result.type !== 'success') return undefined;
	const { held, closesInMs, capped } = result.data as HoldBeat;
	return { held, closesInMs, capped };
}

/** The lease that keeps the undo window of an answer open while its notice is held. */
export const answerHold = (questionId: number, beatMs: number): HoldLease => ({
	beatMs,
	beat: () => beatFor(questionId),
	cappedMessage: (seconds) => t('start.answer.holdCapped', { seconds })
});
