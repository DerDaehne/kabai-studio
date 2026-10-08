/** The four Rekta states plus neutral. Which run state takes which tone is the view's decision. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export const tones: readonly Tone[] = ['neutral', 'info', 'success', 'warning', 'error'];

/** The colour of a small mark (line, bar) in a tone; neutral draws in the surrounding text colour. */
export function markColor(tone: Tone): string {
	return tone === 'neutral' ? 'currentColor' : `var(--mark-${tone})`;
}
