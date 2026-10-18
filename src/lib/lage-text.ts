import { t } from '$lib/i18n/t';
import type { MessageKey } from '$lib/i18n';
import type { Lage, LagePhase, LageReason } from '$lib/lage';
import type { Tone } from '$lib/ui/rekta/tone';

export const LAGE_TONES: Record<Lage, Tone> = {
	waiting: 'warning',
	working: 'info',
	open: 'neutral',
	acceptance: 'neutral',
	done: 'success'
};

type Standing = { lage: Lage; reason: LageReason };

/** The waiting reason of an open ticket, or what a waiting one needs from the human; empty for the other Lagen. */
export function reasonText({ lage, reason }: Standing): string {
	if (reason.kind === 'capacity')
		return reason.causes
			.map(({ code, ...params }) => t(`lage.wait.${code}` as MessageKey, params))
			.join(', ');
	if (lage !== 'waiting' && lage !== 'open') return '';
	const refs = reason.kind === 'predecessors' ? reason.refs.join(', ') : '';
	return t(`lage.reason.${reason.kind}` as MessageKey, { refs });
}

/** The Lage as a word with its reason, so colour never carries the state alone. */
export function lageText(standing: Standing): string {
	const reason = reasonText(standing);
	return reason ? `${t(`lage.${standing.lage}`)} · ${reason}` : t(`lage.${standing.lage}`);
}

/** Where the ticket stands, in everyday words; a step with a working agent says so. */
export const stepText = ({ lage, phase, step }: { lage: Lage; phase: LagePhase; step: string }) =>
	lage === 'working' && phase === 'work'
		? t(`board.step.${step}.working` as MessageKey)
		: t(`board.step.${step}` as MessageKey);
