import type { ProjectPalette } from './ProjectTag.svelte';

/**
 * What an item shows: a status, or `primary` for the one primary action.
 * `running` is not a signal; a working item only gets the ambient tint of its project.
 */
export type AuraTone = 'waiting' | 'failed' | 'paused' | 'succeeded' | 'running' | 'primary';

export interface AuraCandidate {
	key: string;
	tone?: AuraTone;
	/** Selected or keyboard-focused. */
	focused?: boolean;
	project?: ProjectPalette;
}

export type AuraStrength = 'strong' | 'weak' | 'ambient';

export interface Aura {
	strength: AuraStrength;
	/** A CSS colour, always one of the --aura-* tokens. */
	color: string;
}

export const auraOpacity: Record<AuraStrength, number> = { strong: 1, weak: 0.5, ambient: 0.3 };

const budget = { strong: 1, weak: 2 };

/** Most important first. A blocked agent outranks the button that leads to it. */
const signalPriority = ['decision in focus', 'blocking', 'primary action', 'failure', 'focus light', 'paused', 'done'] as const;
type Signal = (typeof signalPriority)[number];

const decisionTones: ReadonlySet<AuraTone> = new Set(['waiting', 'failed', 'paused', 'succeeded']);

function signalOf({ tone, focused }: AuraCandidate): Signal | undefined {
	if (focused && tone && decisionTones.has(tone)) return 'decision in focus';
	if (tone === 'waiting') return 'blocking';
	if (tone === 'primary') return 'primary action';
	if (tone === 'failed') return 'failure';
	if (focused) return 'focus light';
	if (tone === 'paused') return 'paused';
	if (tone === 'succeeded') return 'done';
	return undefined;
}

function signalColor(signal: Signal, tone: AuraTone | undefined): string {
	return signal === 'primary action' || signal === 'focus light' ? 'var(--aura-accent)' : `var(--aura-${tone})`;
}

/**
 * Hands out auras for everything visible at once, across all lists of a view: an aura is a signal, not decoration.
 * Exactly one strong aura for the most important signal, at most two weak ones, none for the rest; ties keep
 * page order. Working items get their project's ambient tint, which never lands on an item that signals.
 */
export function assignAurae(candidates: readonly AuraCandidate[]): Map<string, Aura> {
	const signals = new Map(candidates.map((candidate) => [candidate.key, signalOf(candidate)]));
	const rank = (candidate: AuraCandidate) => signalPriority.indexOf(signals.get(candidate.key)!);
	const signalling = candidates.filter((candidate) => signals.get(candidate.key)).sort((a, b) => rank(a) - rank(b));

	const aurae = new Map<string, Aura>();
	signalling.slice(0, budget.strong + budget.weak).forEach((candidate, place) => {
		const strength = place < budget.strong ? 'strong' : 'weak';
		aurae.set(candidate.key, { strength, color: signalColor(signals.get(candidate.key)!, candidate.tone) });
	});
	for (const candidate of candidates) {
		if (candidate.tone === 'running' && candidate.project && !signals.get(candidate.key)) {
			aurae.set(candidate.key, { strength: 'ambient', color: `var(--aura-project-${candidate.project})` });
		}
	}
	return aurae;
}
