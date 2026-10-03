/**
 * Alternative key sequences sharing one meaning (`j`/`k`, `gs`), each in `KeyboardEvent.key` names; `counted` keys accept a
 * leading count such as `3j`.
 */
export type KeyHint = { keys: string[][]; label: string; counted?: boolean };

export type KeyContext = 'stellwerk' | 'takt' | 'board' | 'page' | 'commandline';

export const contextLabels: Record<KeyContext, string> = {
	stellwerk: 'Stellwerk',
	takt: 'Takt',
	board: 'Board',
	page: 'Seite',
	commandline: 'Befehlszeile'
};

const everywhere: KeyHint[] = [
	{ keys: [['g', 'g']], label: 'Anfang', counted: true },
	{ keys: [['g', 's']], label: 'Stellwerk' },
	{ keys: [['g', 't']], label: 'Takt' },
	{ keys: [['g', 'b']], label: 'Board' },
	{ keys: [['/']], label: 'Suche' },
	{ keys: [[':']], label: 'Befehl' },
	{ keys: [['?']], label: 'alle Tasten' }
];

export const contextKeys: Record<KeyContext, KeyHint[]> = {
	stellwerk: [
		{ keys: [['j'], ['k']], label: 'Spur', counted: true },
		{ keys: [['h'], ['l']], label: 'Schritt', counted: true },
		{ keys: [['Enter']], label: 'Run' },
		{ keys: [['x']], label: 'stoppen' },
		...everywhere
	],
	takt: [
		{ keys: [['1'], ['2'], ['3']], label: 'antworten' },
		{ keys: [['i']], label: 'eigene Antwort' },
		{ keys: [['s']], label: 'später' },
		{ keys: [['u']], label: 'rückgängig', counted: true },
		...everywhere
	],
	board: [
		{ keys: [['j'], ['k']], label: 'Zeile', counted: true },
		{ keys: [['Enter']], label: 'öffnen' },
		{ keys: [['>'], ['<']], label: 'Spalte' },
		...everywhere
	],
	page: everywhere,
	commandline: [
		{ keys: [['ArrowUp'], ['ArrowDown']], label: 'wählen' },
		{ keys: [['Enter']], label: 'ausführen' },
		{ keys: [['Escape']], label: 'schließen' }
	]
};

/** The hint reduced to the sequences that continue `prefix`; empty when none does. */
export function continuing(hint: KeyHint, prefix: string): KeyHint[] {
	const keys = hint.keys.filter(
		(sequence) =>
			sequence.length > prefix.length && sequence.slice(0, prefix.length).join('') === prefix
	);
	return keys.length ? [{ ...hint, keys }] : [];
}

/**
 * The keys that are valid right now. `pending` is what the key router has buffered so far: a count (`3`), a prefix
 * (`g`) or both (`5g`); only the keys that can continue it remain.
 */
export function validKeys(
	context: KeyContext,
	pending: string
): { count: string; prefix: string; hints: KeyHint[] } {
	const [, count = '', prefix = ''] = /^(\d*)(.*)$/.exec(pending) ?? [];
	let hints = contextKeys[context];
	if (count) hints = hints.filter((hint) => hint.counted);
	if (prefix) hints = hints.flatMap((hint) => continuing(hint, prefix));
	return { count, prefix, hints };
}
