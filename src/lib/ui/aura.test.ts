import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { assignAurae, type AuraCandidate, type AuraTone } from './aura';
import AuraList from './AuraList.svelte';

const tones: (AuraTone | undefined)[] = [
	undefined,
	'running',
	'waiting',
	'failed',
	'paused',
	'succeeded',
	'primary'
];
const variants: Omit<AuraCandidate, 'key'>[] = tones.flatMap((tone) => [
	{ tone, project: 2 },
	{ tone, project: 2, focused: true }
]);

function* everyList(
	length: number,
	prefix: Omit<AuraCandidate, 'key'>[] = []
): Generator<AuraCandidate[]> {
	if (prefix.length === length) {
		yield prefix.map((variant, index) => ({ ...variant, key: `item-${index}` }));
		return;
	}
	for (const variant of variants) yield* everyList(length, [...prefix, variant]);
}

const signals = ({ tone, focused }: AuraCandidate) =>
	Boolean(focused || (tone && tone !== 'running'));

describe('aura budget', () => {
	it('gives exactly one strong and at most two weak auras, and never a project tint to an item that signals', () => {
		const violations: string[] = [];
		for (const list of everyList(4)) {
			const aurae = assignAurae(list);
			const count = (strength: string) =>
				[...aurae.values()].filter((aura) => aura.strength === strength).length;
			const signalling = list.filter(signals);
			const broken =
				count('strong') !== Math.min(1, signalling.length) ||
				count('weak') !== Math.min(2, Math.max(0, signalling.length - 1)) ||
				signalling.some((candidate) => aurae.get(candidate.key)?.strength === 'ambient');
			if (broken) violations.push(JSON.stringify({ list, aurae: [...aurae] }));
		}
		expect(violations).toEqual([]);
	});

	it('leaves every signal after the third without an aura', () => {
		const aurae = assignAurae(
			['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, tone: 'failed' as const }))
		);
		expect([...aurae.entries()].map(([key, aura]) => `${key} ${aura.strength}`)).toEqual([
			'a strong',
			'b weak',
			'c weak'
		]);
	});
});

describe('aura priority', () => {
	const strongest = (candidates: AuraCandidate[]) =>
		[...assignAurae(candidates)].find(([, aura]) => aura.strength === 'strong');

	it('lights the decision in focus strongest, in the colour of what it decides', () => {
		const candidates: AuraCandidate[] = [
			{ key: 'blocked lane', tone: 'waiting' },
			{ key: 'start button', tone: 'primary' },
			{ key: 'decision card', tone: 'failed', focused: true }
		];
		expect(strongest(candidates)).toEqual([
			'decision card',
			{ strength: 'strong', color: 'var(--aura-failed)' }
		]);
	});

	it('ranks a blocked agent above the primary action that leads to it', () => {
		expect(
			strongest([
				{ key: 'start button', tone: 'primary' },
				{ key: 'blocked lane', tone: 'waiting' }
			])?.[0]
		).toBe('blocked lane');
	});

	it('follows decision > blocking > primary > failure > focus light > paused > done', () => {
		const ordered: AuraCandidate[] = [
			{ key: 'done', tone: 'succeeded' },
			{ key: 'paused', tone: 'paused' },
			{ key: 'focus light', tone: 'running', focused: true },
			{ key: 'failure', tone: 'failed' },
			{ key: 'primary', tone: 'primary' },
			{ key: 'blocking', tone: 'waiting' },
			{ key: 'decision', tone: 'waiting', focused: true }
		];
		const winners: string[] = [];
		for (
			let remaining = [...ordered];
			remaining.length;
			remaining = remaining.filter((candidate) => candidate.key !== winners.at(-1))
		) {
			winners.push(strongest(remaining)![0]);
		}
		expect(winners).toEqual([
			'decision',
			'blocking',
			'primary',
			'failure',
			'focus light',
			'paused',
			'done'
		]);
	});

	it('keeps page order between equal signals', () => {
		const aurae = assignAurae([
			{ key: 'first', tone: 'waiting' },
			{ key: 'second', tone: 'waiting' }
		]);
		expect(aurae.get('first')?.strength).toBe('strong');
		expect(aurae.get('second')?.strength).toBe('weak');
	});

	it('uses the accent focus light only when the focused item carries no signal of its own', () => {
		expect(
			assignAurae([{ key: 'lane', tone: 'running', project: 3, focused: true }]).get('lane')
		).toEqual({ strength: 'strong', color: 'var(--aura-accent)' });
		expect(assignAurae([{ key: 'lane', tone: 'paused', focused: true }]).get('lane')).toEqual({
			strength: 'strong',
			color: 'var(--aura-paused)'
		});
	});

	it('tints working items of a project ambiently, outside the budget', () => {
		const aurae = assignAurae([
			{ key: 'working', tone: 'running', project: 4 },
			{ key: 'no project', tone: 'running' },
			{ key: 'blocked', tone: 'waiting', project: 4 }
		]);
		expect(aurae.get('working')).toEqual({ strength: 'ambient', color: 'var(--aura-project-4)' });
		expect(aurae.has('no project')).toBe(false);
		expect(aurae.get('blocked')?.color).toBe('var(--aura-waiting)');
	});
});

describe('AuraList', () => {
	it('renders auras at their final opacity, so they stay visible and static when motion is reduced', () => {
		const items: AuraCandidate[] = [
			{ key: 'decision', tone: 'waiting', focused: true },
			{ key: 'failure', tone: 'failed' },
			{ key: 'working', tone: 'running', project: 1 },
			{ key: 'idle' }
		];
		const item = createRawSnippet((entry: () => AuraCandidate) => ({
			render: () => `<span>${entry().key}</span>`
		}));
		const { body } = render(AuraList<AuraCandidate>, {
			props: { items, aurae: assignAurae(items), item, label: 'Runs' }
		});

		const glows = [...body.matchAll(/<li class="glow[^"]*" aria-hidden="true"([^>]*)>/g)].map(
			(match) => match[1]
		);
		expect(glows).toHaveLength(items.length);
		expect(glows[0]).toMatch(
			/data-strength="strong".*grid-row: 1 \/ span 1; opacity: 1; background-color: var\(--aura-waiting\)/
		);
		expect(glows[1]).toMatch(
			/data-strength="weak".*opacity: 0\.5; background-color: var\(--aura-failed\)/
		);
		expect(glows[2]).toMatch(
			/data-strength="ambient".*opacity: 0\.3; background-color: var\(--aura-project-1\)/
		);
		expect(glows[3]).toMatch(/opacity: 0/);
		glows.forEach((glow, row) => expect(glow).toContain(`grid-row: ${row + 1} / span 1;`));
		expect(body).toContain('<span>decision</span>');
	});
});
