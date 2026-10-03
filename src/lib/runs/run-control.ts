import type { Suggestion } from '$lib/shell/commands';
import { clock, formatCount, type RunTraceState } from '$lib/trace/trace';

/** One run of a ticket as its tab in the Run-Akte shows it; times are ISO in UTC. */
export type RunTab = {
	id: number;
	state: RunTraceState;
	/** `null` once the profile has been deleted. */
	profile: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	tokensIn: number;
	tokensOut: number;
	/** USD; 0 for a local model. */
	cost: number;
	resumedFrom: number | null;
	resumeReason: 'context_budget' | 'recovery' | 'quota' | null;
	/** Only while queued: why the run does not start yet. */
	waitText?: string;
};

export type StartProfile = { id: number; name: string };

/** The profiles a run can start with; `preselected` is the one this project used last, else the first. */
export type RunStart = { profiles: StartProfile[]; preselected?: number };

const ORIGINS: Record<NonNullable<RunTab['resumeReason']>, string> = {
	context_budget: 'frischer Run nach Kontextgrenze',
	recovery: 'frischer Run nach Stillstand oder Längenlimit',
	quota: 'Fortsetzung nach Kontingent-Pause'
};

/** Why a continuation run exists; a continuation without a reason is the one the human's answer queued. */
export function originText(tab: RunTab): string | undefined {
	if (tab.resumedFrom === null) return undefined;
	return tab.resumeReason ? ORIGINS[tab.resumeReason] : 'Fortsetzung nach deiner Antwort';
}

/** How long the run has worked, up to `now` while it still does; empty before it started. */
export function durationText(tab: Pick<RunTab, 'startedAt' | 'finishedAt'>, now: number): string {
	if (!tab.startedAt) return '';
	const end = tab.finishedAt ? Date.parse(tab.finishedAt) : now;
	return clock(Math.max(0, end - Date.parse(tab.startedAt)));
}

// a cloud run's cost often stays below a cent, so a few more digits keep it from reading as nothing
const dollars = new Intl.NumberFormat('de-DE', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 4
});

export const usageText = (tab: Pick<RunTab, 'tokensIn' | 'tokensOut' | 'cost'>) =>
	`Tokens ${formatCount(tab.tokensIn)} ein · ${formatCount(tab.tokensOut)} aus · ${dollars.format(tab.cost)}`;

const ACTIVE = new Set<RunTraceState>(['queued', 'running', 'waiting_approval']);
export const isStoppable = (tab: RunTab) => ACTIVE.has(tab.state);

/** The run `x` stops: the selected one while it is active, else the newest active one (tabs are newest first). */
export function stopTarget(tabs: RunTab[], selected?: number): RunTab | undefined {
	const chosen = tabs.find((tab) => tab.id === selected);
	return chosen && isStoppable(chosen) ? chosen : tabs.find(isStoppable);
}

/**
 * The Run-Akte's `:run` commands: `:run` starts with the chosen profile, `:run <name>` with another one. Without
 * any profile `:run` leads to where one is created instead.
 */
export function runCommands(
	profiles: StartProfile[],
	chosen: number | undefined,
	startWith: (profileId: number) => void
): Suggestion[] {
	const profile = profiles.find((p) => p.id === chosen);
	if (!profile)
		return [
			{
				id: 'run',
				label: ':run',
				detail: 'Erst ein Agent-Profil anlegen',
				href: '/settings/profiles'
			}
		];
	const others = profiles.filter((p) => p !== profile);
	return [
		{
			id: 'run',
			label: ':run',
			detail: `Run starten mit „${profile.name}“`,
			run: () => startWith(profile.id)
		},
		...others.map((other) => ({
			id: `run-${other.id}`,
			label: `:run ${other.name}`,
			detail: 'Run mit diesem Profil starten',
			run: () => startWith(other.id)
		}))
	];
}
