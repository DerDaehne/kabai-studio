import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Prüft die Farbpaare aus tokens.css gegen WCAG 2.2 AA (Text 4.5:1, Bedienelement-Kanten/Fokus 3:1), hell und dunkel.
// `--reporter=verbose` listet jedes Paar mit seinem Kontrastverhältnis.
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const decls = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function resolve(value: string, mode: 0 | 1): string {
	const ld = value.match(/^light-dark\((.+),\s*(.+)\)$/);
	if (ld) return resolve(ld[1 + mode].trim(), mode);
	const ref = value.match(/^var\((--[\w-]+)\)$/);
	if (ref) return resolve(decls.get(ref[1]) ?? `unbekannt: ${ref[1]}`, mode);
	return value;
}

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const surfaces = ['--bg', '--bg-chrome', '--surface', '--surface-hover'];
const statuses = ['running', 'waiting', 'failed', 'succeeded', 'paused', 'neutral'];
const pairs: [fg: string, bg: string, min: number][] = [
	...['--text', '--text-muted', '--accent-text'].flatMap((fg) => surfaces.map((bg): [string, string, number] => [fg, bg, 4.5])),
	['--accent-text', '--accent-tint', 4.5],
	['--on-accent', '--accent', 4.5],
	['--on-accent', '--accent-hover', 4.5],
	...statuses.flatMap((s): [string, string, number][] => [
		[`--status-${s}`, `--status-${s}-tint`, 4.5],
		[`--status-${s}`, '--bg', 4.5],
		[`--status-${s}`, '--surface', 4.5]
	]),
	...['--border-control', '--focus'].flatMap((fg) => ['--bg', '--bg-chrome', '--surface'].map((bg): [string, string, number] => [fg, bg, 3]))
];

const rows = pairs.flatMap(([fg, bg, min]) =>
	([0, 1] as const).map((mode) => {
		const [a, b] = [resolve(`var(${fg})`, mode), resolve(`var(${bg})`, mode)];
		return { fg, bg, min, a, b, mode: mode ? 'dunkel' : 'hell', ratio: ratio(a, b).toFixed(2) };
	})
);

describe('Token-Kontrast (WCAG AA)', () => {
	it.each(rows)('$fg auf $bg ($mode): $ratio:1 (≥ $min)', ({ a, b, min, ratio: r }) => {
		expect(a).toMatch(/^#[0-9a-f]{6}$/);
		expect(b).toMatch(/^#[0-9a-f]{6}$/);
		expect(Number(r)).toBeGreaterThanOrEqual(min);
	});
});
