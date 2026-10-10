import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Checks every text and control colour pair of tokens.css against WCAG 2.2 AA (text 4.5:1, control edges and
// focus 3:1), light and dark, in every glass strength. Translucent layers are blended over each backdrop they can
// lie on and the worst case counts. `--reporter=verbose` lists each pair with its ratio.

type Rgba = [red: number, green: number, blue: number, alpha: number];
type Mode = 'light' | 'dark';
type Declarations = ReadonlyMap<string, string>;
type Backdrops = Record<string, Rgba>;
interface PairResult {
	fg: string;
	against: string;
	mode: Mode;
	min: number;
	ratio: number;
	worst: string;
}

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function declarationsOf(body: string): Map<string, string> {
	return new Map(
		[...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
			match[1],
			match[2].replace(/\s+/g, ' ').trim()
		])
	);
}

/** Splits a function's arguments at top-level commas, so a nested color-mix() stays whole. */
function topLevelArgs(inner: string): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < inner.length; index++) {
		if (inner[index] === '(') depth++;
		else if (inner[index] === ')') depth--;
		else if (inner[index] === ',' && depth === 0) {
			args.push(inner.slice(start, index).trim());
			start = index + 1;
		}
	}
	return [...args, inner.slice(start).trim()];
}

function ruleBody(selector: string, source = css): string {
	const start = source.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`no rule "${selector}"`);
	const open = source.indexOf('{', start) + 1;
	return source.slice(open, source.indexOf('}', open));
}

const reducedTransparencyRule = css.match(
	/@media \(prefers-reduced-transparency: reduce\) \{\s*([^{]+)\{([^}]*)\}/
);
const rootDeclarations = declarationsOf(ruleBody(':root'));

// The base tokens point into the vendored rekta.css, which carries dark mode on its own rule
// (:root[data-theme='dark'], the same values as its prefers-color-scheme block) instead of light-dark().
const rekta = readFileSync(new URL('./rekta.css', import.meta.url), 'utf8');
const rektaLight = declarationsOf(ruleBody(':root', rekta));
const rektaDark = new Map([
	...rektaLight,
	...declarationsOf(ruleBody(":root[data-theme='dark']", rekta))
]);
const rektaByMode: Record<Mode, Declarations> = { light: rektaLight, dark: rektaDark };

const glassStrengths = {
	bold: new Map<string, string>(),
	frosted: declarationsOf(ruleBody(":root[data-glass='frosted']")),
	solid: declarationsOf(ruleBody(":root[data-glass='solid']"))
} satisfies Record<string, Declarations>;
type GlassStrength = keyof typeof glassStrengths;

function parseColor(value: string): Rgba {
	const hex = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
	if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1];
	const rgb = value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
	if (rgb)
		return [
			Number(rgb[1]),
			Number(rgb[2]),
			Number(rgb[3]),
			rgb[4] === undefined ? 1 : Number(rgb[4])
		];
	throw new Error(`not a colour: ${value}`);
}

/** `color-mix(in srgb, <a> <p>%, <b>)` for two opaque colours: the share p of a, the rest of b. */
function mixSrgb(declarations: Declarations, args: string[], mode: Mode): string {
	const [space, first, second] = args;
	if (space !== 'in srgb') throw new Error(`unsupported colour-mix space: ${space}`);
	const share = first.match(/^(.*?)\s+([\d.]+)%$/);
	const weight = share ? Number(share[2]) / 100 : 0.5;
	const a = parseColor(resolve(declarations, share ? share[1] : first, mode));
	const b = parseColor(resolve(declarations, second, mode));
	const channel = (index: number) => Math.round(a[index] * weight + b[index] * (1 - weight));
	return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

function resolve(declarations: Declarations, value: string, mode: Mode): string {
	const call = value.match(/^(light-dark|color-mix)\((.*)\)$/);
	if (call?.[1] === 'light-dark') {
		const [light, dark] = topLevelArgs(call[2]);
		return resolve(declarations, mode === 'light' ? light : dark, mode);
	}
	if (call?.[1] === 'color-mix') return mixSrgb(declarations, topLevelArgs(call[2]), mode);
	const reference = value.match(/^var\((--[\w-]+)\)$/);
	if (reference) {
		const target = declarations.get(reference[1]);
		if (target === undefined) throw new Error(`unknown token ${reference[1]}`);
		return resolve(declarations, target, mode);
	}
	return value;
}

function over([red, green, blue, alpha]: Rgba, [baseRed, baseGreen, baseBlue]: Rgba): Rgba {
	const blend = (top: number, bottom: number) => top * alpha + bottom * (1 - alpha);
	return [blend(red, baseRed), blend(green, baseGreen), blend(blue, baseBlue), 1];
}

function luminance([red, green, blue]: Rgba): number {
	const linear = (channel: number) => {
		const c = channel / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(a: Rgba, b: Rgba): number {
	const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (lighter + 0.05) / (darker + 0.05);
}

const statuses = ['running', 'waiting', 'failed', 'succeeded', 'paused'];
const projectSlots = [1, 2, 3, 4, 5];
// Blurred text under an overlay covers about 15-25 % of the area; 35 % adds a safety margin
const blurredTextCoverage = 0.35;
const blurThatSoftensText = 20;

type ColorOf = (token: string) => Rgba;

function worstCase(
	color: ColorOf,
	mode: Mode,
	fg: string,
	backdrops: Backdrops,
	against: string,
	min = 4.5
): PairResult {
	let worst = { ratio: Infinity, name: '' };
	for (const [name, backdrop] of Object.entries(backdrops)) {
		const ratio = contrast(color(fg), backdrop);
		if (ratio < worst.ratio) worst = { ratio, name };
	}
	return { fg, against, mode, min, ratio: Number(worst.ratio.toFixed(2)), worst: worst.name };
}

function checkContrast(declarations: Declarations): PairResult[] {
	const results: PairResult[] = [];
	for (const mode of ['light', 'dark'] as const) {
		const merged = new Map([...declarations, ...rektaByMode[mode]]);
		const color = (token: string) => parseColor(resolve(merged, `var(${token})`, mode));
		const opaque = (...tokens: string[]): Backdrops =>
			Object.fromEntries(tokens.map((token) => [token, color(token)]));
		const ground = color('--bg');
		const check = (fg: string, backdrops: Backdrops, against: string, min = 4.5) =>
			results.push(worstCase(color, mode, fg, backdrops, against, min));

		const underCards: Backdrops = { '--bg': ground };
		const backgroundTokens = [...declarations.keys()].filter((t) => /^--(aura|nebula)-/.test(t));
		for (const token of backgroundTokens) underCards[token] = over(color(token), ground);
		const glassOver = (glass: string, backdrops: Backdrops): Backdrops =>
			Object.fromEntries(
				Object.entries(backdrops).map(([name, backdrop]) => [name, over(color(glass), backdrop)])
			);
		const withFills = (backdrops: Backdrops, fills: string[]): Backdrops => {
			const result: Backdrops = { ...backdrops };
			for (const [name, backdrop] of Object.entries(backdrops)) {
				for (const fill of fills) result[`${name} + ${fill}`] = over(color(fill), backdrop);
			}
			return result;
		};
		// Selection fills appear in lists on plain cards; the raised decision card only carries buttons
		const cards: Backdrops = {
			...withFills(glassOver('--glass-card', underCards), ['--fill-sel', '--fill-soft']),
			...Object.fromEntries(
				Object.entries(withFills(glassOver('--glass-raised', underCards), ['--fill-soft'])).map(
					([name, rgba]) => [`raised over ${name}`, rgba]
				)
			)
		};
		const docks = glassOver('--glass-float', underCards);
		const plainCard = over(color('--glass-card'), ground);
		const text = color('--text');
		const textBeneath =
			parseFloat(resolve(declarations, 'var(--blur-float)', mode)) >= blurThatSoftensText
				? over([text[0], text[1], text[2], blurredTextCoverage], plainCard)
				: text;
		const overlays = glassOver('--glass-overlay', {
			'--bg': ground,
			card: plainCard,
			...opaque('--accent', '--accent-tint', '--status-waiting-tint'),
			'text beneath': textBeneath
		});
		const surfaces = opaque('--surface', '--surface-raised', '--surface-sunken', '--surface-hover');
		const statusTints = opaque(...statuses.map((status) => `--status-${status}-tint`));

		for (const fg of ['--text', '--text-muted', '--accent-text']) {
			check(fg, { '--bg': ground }, 'ground');
			check(fg, surfaces, 'opaque surfaces');
			check(fg, cards, 'card glass');
			check(fg, docks, 'dock glass');
			check(fg, overlays, 'overlay glass');
			check(fg, opaque('--accent-tint'), 'accent tint');
		}
		check('--text', statusTints, 'status tints');
		check('--text-muted', statusTints, 'status tints');
		check('--on-accent', opaque('--accent', '--accent-hover'), 'accent');
		for (const status of [...statuses, 'neutral']) {
			check(`--status-${status}`, opaque(`--status-${status}-tint`), 'own tint');
			check(
				`--status-${status}`,
				{ '--bg': ground, ...surfaces, ...cards },
				'ground, surfaces and cards'
			);
			check(`--status-${status}`, { ...docks, ...overlays }, 'dock and overlay glass');
		}
		check('--text', opaque('--kbd-bg'), 'key cap');
		// The focus ring sits on a halo in the ground colour, so the ground is its only backdrop
		check('--focus', { '--bg': ground }, 'halo', 3);
		// Input fields rest on the ground or a resting surface; the hover fill is a control's own background
		check(
			'--border-control',
			{ '--bg': ground, ...opaque('--surface', '--surface-raised', '--surface-sunken') },
			'input field',
			3
		);
		for (const slot of projectSlots)
			check(`--project-${slot}`, opaque(`--project-${slot}-fill`), 'project tag');
	}
	return results;
}

const withStrength = (strength: GlassStrength, overrides: Declarations = new Map()) =>
	new Map([...rootDeclarations, ...glassStrengths[strength], ...overrides]);
const belowMinimum = (results: PairResult[]) =>
	results.filter((result) => result.ratio < result.min);

describe.each(Object.keys(glassStrengths) as GlassStrength[])(
	'token contrast, spring accent with %s glass',
	(strength) => {
		it.each(checkContrast(withStrength(strength)))(
			'$fg on $against ($mode): $ratio:1 ≥ $min, worst on $worst',
			({ ratio, min }) => {
				expect(ratio).toBeGreaterThanOrEqual(min);
			}
		);
	}
);

describe('the default, spring accent with bold glass', () => {
	const results = checkContrast(withStrength('bold'));

	it(`meets AA in all ${results.length} pairs`, () => {
		expect(belowMinimum(results)).toEqual([]);
	});

	it('is what the root rule declares, so it applies without any data-glass attribute', () => {
		expect(rootDeclarations.get('--glass-card')).toBe(
			'light-dark(rgb(252 254 254 / 0.6), rgb(25 31 34 / 0.6))'
		);
		expect(rootDeclarations.get('--accent')).toBe('light-dark(var(--a-500), var(--a-400))');
	});

	it('fails the check when card glass drops to 0.4 opacity', () => {
		const thinCardGlass = new Map([
			['--glass-card', 'light-dark(rgb(252 254 254 / 0.4), rgb(25 31 34 / 0.4))']
		]);
		expect(belowMinimum(checkContrast(withStrength('bold', thinCardGlass))).length).toBeGreaterThan(
			0
		);
	});

	it('fails the check when --text-muted points at the low-contrast Rekta step', () => {
		const lowContrastMuted = new Map([['--text-muted', 'var(--rekta-color-text-contrast-low)']]);
		expect(
			belowMinimum(checkContrast(withStrength('bold', lowContrastMuted))).length
		).toBeGreaterThan(0);
	});
});

describe('focus ring', () => {
	it('sits on a halo in the ground colour, which is what lets the check above use the ground as its only backdrop', () => {
		const base = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
		const focusRule = base.match(/\n:focus-visible \{([^}]*)\}/)?.[1] ?? '';
		expect(focusRule).toContain('outline: 2px solid var(--focus);');
		expect(focusRule).toContain('box-shadow: 0 0 0 5px var(--bg);');
	});
});

describe('prefers-reduced-transparency', () => {
	it('switches to the solid glass values', () => {
		expect(reducedTransparencyRule).not.toBeNull();
		expect(declarationsOf(reducedTransparencyRule![2])).toEqual(glassStrengths.solid);
	});

	it('overrides an explicit glass choice by matching every data-glass value and coming last', () => {
		expect(reducedTransparencyRule![1].split(',').map((selector) => selector.trim())).toEqual([
			':root',
			':root[data-glass]'
		]);
		expect(css.indexOf('@media (prefers-reduced-transparency')).toBeGreaterThan(
			css.indexOf(":root[data-glass='solid']")
		);
		expect(css.indexOf('@media (prefers-reduced-transparency')).toBeGreaterThan(
			css.indexOf(":root[data-glass='frosted']")
		);
	});
});

// The Rekta tile language takes its values from the same vendored rekta.css declarations as rektaLight/rektaDark.
const tones = ['neutral', 'info', 'success', 'warning', 'error'];

function checkTileContrast(
	rektaByMode: Record<Mode, Declarations> = { light: rektaLight, dark: rektaDark }
): PairResult[] {
	return (['light', 'dark'] as const).flatMap((mode) => {
		const declarations = new Map([...withStrength('bold'), ...rektaByMode[mode]]);
		const color = (token: string) => parseColor(resolve(declarations, `var(${token})`, mode));
		const opaque = (...tokens: string[]): Backdrops =>
			Object.fromEntries(tokens.map((token) => [token, color(token)]));
		const fills = opaque(...tones.map((tone) => `--tile-${tone}`));
		const rektaGround = opaque('--rekta-color-bg', '--rekta-color-surface');
		return [
			// The tile's focus ring is drawn in its text colour, so this pair covers the ring as well
			worstCase(color, mode, '--text', fills, 'tile fills'),
			worstCase(color, mode, '--text-muted', opaque('--tile-neutral'), 'neutral tile'),
			worstCase(color, mode, '--rekta-color-text-primary', fills, 'tile fills'),
			worstCase(color, mode, '--rekta-color-text-contrast-high', rektaGround, 'Rekta ground'),
			worstCase(color, mode, '--rekta-color-focus', rektaGround, 'Rekta ground', 3)
		];
	});
}

describe('Rekta tile language, from the vendored values', () => {
	it.each(checkTileContrast())(
		'$fg on $against ($mode): $ratio:1 ≥ $min, worst on $worst',
		({ ratio, min }) => {
			expect(ratio).toBeGreaterThanOrEqual(min);
		}
	);

	it('fails the check when a dark tile fill gets as light as its light-theme counterpart', () => {
		const lighterInfoTile = new Map([
			...rektaDark,
			['--rekta-color-status-info-tile', rektaLight.get('--rekta-color-status-info-tile')!]
		]);
		const results = checkTileContrast({ light: rektaLight, dark: lighterInfoTile });
		expect(belowMinimum(results).map(({ fg, mode }) => `${fg} ${mode}`)).toEqual([
			'--text dark',
			'--rekta-color-text-primary dark'
		]);
	});
});
