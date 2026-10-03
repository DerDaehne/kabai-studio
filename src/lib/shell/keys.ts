/**
 * Alternative key sequences sharing one meaning (`j`/`k`, `gs`), each in `KeyboardEvent.key` names plus `Ctrl+…` for
 * chords; `counted` keys accept a leading count such as `3j`.
 */
export type KeyHint = { keys: string[][]; label: string; counted?: boolean };

export type KeyGroup =
	| 'Bewegen'
	| 'Öffnen und zurück'
	| 'Entscheiden'
	| 'Bearbeiten'
	| 'Suchen und Befehle'
	| 'Projekte und Übersicht';

type KeyBinding = KeyHint & { group: KeyGroup };

/** Stands for any letter a–z in a sequence, such as the project letter after the leader. */
export const anyLetter = 'a–z';

const leader = ' ';

/**
 * Every key the router knows, in the order the `?` overview lists them. Views bind handlers to these actions; when
 * several bound actions share a key, the one listed first wins (Escape ends a search before it goes back).
 */
const keymapTable = {
	move: { group: 'Bewegen', keys: [['j'], ['k']], label: 'nächstes/voriges', counted: true },
	side: { group: 'Bewegen', keys: [['h'], ['l']], label: 'links/rechts', counted: true },
	edge: { group: 'Bewegen', keys: [['g', 'g'], ['G']], label: 'Anfang/Ende', counted: true },
	group: { group: 'Bewegen', keys: [['{'], ['}']], label: 'Gruppe bzw. Datei', counted: true },
	open: { group: 'Öffnen und zurück', keys: [['Enter'], ['g', 'd']], label: 'öffnen' },
	endSearch: { group: 'Öffnen und zurück', keys: [['Escape']], label: 'Suche beenden' },
	back: { group: 'Öffnen und zurück', keys: [['Escape']], label: 'zurück' },
	jumpBack: { group: 'Öffnen und zurück', keys: [['Ctrl+o']], label: 'vorige Stelle' },
	goStellwerk: { group: 'Öffnen und zurück', keys: [['g', 's']], label: 'Stellwerk' },
	goTakt: { group: 'Öffnen und zurück', keys: [['g', 't']], label: 'Takt' },
	goBoard: { group: 'Öffnen und zurück', keys: [['g', 'b']], label: 'Board' },
	goLastRun: { group: 'Öffnen und zurück', keys: [['g', 'r']], label: 'letzter Run' },
	answer: { group: 'Entscheiden', keys: [['1'], ['2'], ['3']], label: 'antworten' },
	answerOwn: { group: 'Entscheiden', keys: [['i']], label: 'eigene Antwort' },
	later: { group: 'Entscheiden', keys: [['s']], label: 'später' },
	undo: { group: 'Entscheiden', keys: [['u']], label: 'rückgängig', counted: true },
	redo: { group: 'Entscheiden', keys: [['Ctrl+r']], label: 'wiederholen', counted: true },
	editText: { group: 'Bearbeiten', keys: [['i']], label: 'Text bearbeiten' },
	comment: { group: 'Bearbeiten', keys: [['a']], label: 'Kommentar' },
	add: { group: 'Bearbeiten', keys: [['o'], ['O']], label: 'neu darunter/darüber' },
	remove: { group: 'Bearbeiten', keys: [['d', 'd']], label: 'löschen' },
	stopRun: { group: 'Bearbeiten', keys: [['x']], label: 'Run stoppen' },
	confirm: { group: 'Bearbeiten', keys: [['y']], label: 'bestätigen' },
	shiftColumn: {
		group: 'Bearbeiten',
		keys: [['>'], ['<']],
		label: 'Spalte weiter/zurück',
		counted: true
	},
	copy: { group: 'Bearbeiten', keys: [['y', 'y']], label: 'ID/Pfad kopieren' },
	search: { group: 'Suchen und Befehle', keys: [['/']], label: 'Suche' },
	hit: { group: 'Suchen und Befehle', keys: [['n'], ['N']], label: 'Treffer', counted: true },
	command: { group: 'Suchen und Befehle', keys: [[':']], label: 'Befehl' },
	focusHere: { group: 'Suchen und Befehle', keys: [['*']], label: 'Fokus auf dieses Projekt' },
	diffView: { group: 'Suchen und Befehle', keys: [['v']], label: 'Diff-Darstellung' },
	focusAll: { group: 'Projekte und Übersicht', keys: [[leader, leader]], label: 'alle Projekte' },
	groupBy: { group: 'Projekte und Übersicht', keys: [[leader, 'g']], label: 'gruppieren' },
	focusProject: {
		group: 'Projekte und Übersicht',
		keys: [[leader, anyLetter]],
		label: 'Projekt-Fokus'
	},
	help: { group: 'Projekte und Übersicht', keys: [['?']], label: 'alle Tasten' }
} satisfies Record<string, KeyBinding>;

export type KeyAction = keyof typeof keymapTable;
export const keymap: Record<KeyAction, KeyBinding> = keymapTable;

export type KeyContext = 'stellwerk' | 'takt' | 'board' | 'ticket' | 'page' | 'commandline';

export const contextLabels: Record<KeyContext, string> = {
	stellwerk: 'Stellwerk',
	takt: 'Takt',
	board: 'Board',
	ticket: 'Run-Akte',
	page: 'Seite',
	commandline: 'Befehlszeile'
};

/** The command line handles these keys itself; the router stays out of text fields. */
const commandLineKeys: KeyHint[] = [
	{ keys: [['ArrowUp'], ['ArrowDown']], label: 'wählen' },
	{ keys: [['Enter']], label: 'ausführen' },
	{ keys: [['Escape']], label: 'schließen' }
];

/** Splits what the key router has buffered so far into a count (`3`) and a prefix (`g`); `5g` has both. */
export function splitPending(pending: string): { count: string; prefix: string } {
	const [, count = '', prefix = ''] = /^(\d*)(.*)$/.exec(pending) ?? [];
	return { count, prefix };
}

/** The hint reduced to the sequences that continue `prefix`; empty when none does. */
export function continuing(hint: KeyHint, prefix: string): KeyHint[] {
	const keys = hint.keys.filter(
		(sequence) =>
			sequence.length > prefix.length && sequence.slice(0, prefix.length).join('') === prefix
	);
	return keys.length ? [{ ...hint, keys }] : [];
}

/**
 * The keys that are valid right now: those of the bound actions, narrowed to what can continue the buffered count or
 * prefix (`pending`).
 */
export function validKeys(
	context: KeyContext,
	pending: string,
	bound: ReadonlySet<KeyAction>
): { count: string; prefix: string; hints: KeyHint[] } {
	const { count, prefix } = splitPending(pending);
	if (context === 'commandline') return { count, prefix, hints: commandLineKeys };
	let hints: KeyHint[] = Object.entries(keymap)
		.filter(([action]) => bound.has(action as KeyAction))
		.map(([, binding]) => binding);
	if (count) hints = hints.filter((hint) => hint.counted);
	if (prefix) hints = hints.flatMap((hint) => continuing(hint, prefix));
	return { count, prefix, hints };
}
