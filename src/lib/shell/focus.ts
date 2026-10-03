import type { ProjectRef } from './shell.svelte';

/** Letters a project's code and name can offer for its focus letter, code first, then name. */
function letterCandidates(project: ProjectRef): string[] {
	return `${project.code}${project.name}`.toLowerCase().match(/[a-z]/g) ?? [];
}

/**
 * Assigns each project a unique focus letter: the first letter of its code, or the next free letter of the code
 * then the name once that one is taken. Projects are processed by id, so the result never depends on list order —
 * the same set of projects always gets the same letters, even once several codes collide on the same first letter.
 * A project without any free letter left (exhausted code and name) gets none; it stays reachable via `:fokus`.
 */
export function focusLetters(projects: ProjectRef[]): Map<number, string> {
	const taken = new Set<string>();
	const letters = new Map<number, string>();
	for (const project of [...projects].sort((a, b) => a.id - b.id)) {
		const letter = letterCandidates(project).find((candidate) => !taken.has(candidate));
		if (!letter) continue;
		taken.add(letter);
		letters.set(project.id, letter);
	}
	return letters;
}

/** The project reachable with the leader and `letter` right now, or undefined for a stale or unassigned letter. */
export function projectForLetter(projects: ProjectRef[], letter: string): ProjectRef | undefined {
	const letters = focusLetters(projects);
	return projects.find((project) => letters.get(project.id) === letter);
}

export type FocusKey = { letter: string; project: ProjectRef };

/** Every project with its current focus letter, sorted by letter — what the key bar and the `?` overview show. */
export function focusKeys(projects: ProjectRef[]): FocusKey[] {
	const letters = focusLetters(projects);
	return projects
		.flatMap((project) => {
			const letter = letters.get(project.id);
			return letter ? [{ letter, project }] : [];
		})
		.sort((a, b) => a.letter.localeCompare(b.letter));
}

/** Whether a project is included under the current focus; everything matches when nothing is focused. */
export function inFocus(focus: ProjectRef | null, projectId: number): boolean {
	return focus === null || focus.id === projectId;
}

export type FocusSummary<T> = {
	visible: T[];
	/** "N weitere in M anderen Projekten" ("…Projekt" for M = 1), or '' when nothing is hidden. */
	hiddenLabel: string;
};

/**
 * Splits `items` into what the current focus keeps visible and a one-line summary of what collapses instead of
 * being grayed out. Views apply this themselves; it does nothing when there is no focus.
 */
export function focusSummary<T>(
	items: T[],
	focus: ProjectRef | null,
	projectIdOf: (item: T) => number
): FocusSummary<T> {
	const visible = items.filter((item) => inFocus(focus, projectIdOf(item)));
	const hidden = items.filter((item) => !inFocus(focus, projectIdOf(item)));
	const hiddenProjectCount = new Set(hidden.map(projectIdOf)).size;
	const otherProjects = hiddenProjectCount === 1 ? 'anderen Projekt' : 'anderen Projekten';
	const hiddenLabel = hidden.length
		? `${hidden.length} weitere in ${hiddenProjectCount} ${otherProjects}`
		: '';
	return { visible, hiddenLabel };
}
