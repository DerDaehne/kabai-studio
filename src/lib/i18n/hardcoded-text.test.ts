// Guards against human-facing text written directly into component markup instead of going through `t()`.
// ponytail: checks markup text and user-facing attributes only; strings in <script> (e.g. a label constant) slip
// through. Extend the walk to string literals once the migration has removed most of today's findings.
import { globSync, readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

/** Components that still contain hard-coded text. Migrating one removes it here; never add an entry. */
const NOT_YET_MIGRATED = new Set([
	'src/lib/components/NoProject.svelte',
	'src/lib/components/SecretField.svelte',
	'src/lib/runs/RunControl.svelte',
	'src/lib/shell/AppBar.svelte',
	'src/lib/shell/CommandLine.svelte',
	'src/lib/shell/HaltControl.svelte',
	'src/lib/shell/HeadPivot.svelte',
	'src/lib/shell/KeyOverview.svelte',
	'src/lib/trace/RunTrace.svelte',
	'src/lib/trace/TraceStep.svelte',
	'src/lib/ui/Dialog.svelte',
	'src/lib/ui/Toaster.svelte',
	'src/routes/+error.svelte',
	'src/routes/+layout.svelte',
	'src/routes/+page.svelte',
	'src/routes/board/+page.svelte',
	'src/routes/dev/ui/+page.svelte',
	'src/routes/dev/ui/PivotShowcase.svelte',
	'src/routes/dev/ui/RektaShowcase.svelte',
	'src/routes/p/[key]/+page.svelte',
	'src/routes/p/[key]/t/[number]/+page.svelte',
	'src/routes/projects/+page.svelte',
	'src/routes/settings/+page.svelte',
	'src/routes/settings/profiles/+page.svelte',
	'src/routes/settings/profiles/[id]/+page.svelte',
	'src/routes/settings/profiles/[id]/ProfileForm.svelte',
	'src/routes/settings/secrets/+page.svelte',
	'src/routes/takt/+page.svelte'
]);

const USER_FACING_ATTRIBUTES = new Set([
	'alt',
	'aria-description',
	'aria-label',
	'aria-placeholder',
	'aria-roledescription',
	'aria-valuetext',
	'label',
	'placeholder',
	'title'
]);
const LETTER = /\p{L}/u;

type Node = { type?: string; data?: string; name?: string; value?: unknown };

function collectTexts(node: unknown, found: string[]): void {
	if (Array.isArray(node)) return node.forEach((child) => collectTexts(child, found));
	if (typeof node !== 'object' || node === null) return;
	const { type, data, name, value } = node as Node;
	if (type === 'Text') {
		if (LETTER.test(data ?? '')) found.push((data ?? '').trim());
		return;
	}
	if (type === 'Attribute' && USER_FACING_ATTRIBUTES.has(name ?? ''))
		return collectTexts(value, found);
	if (type === 'Attribute' || type?.endsWith('Directive')) return;
	for (const child of Object.values(node)) collectTexts(child, found);
}

function hardcodedTexts(source: string): string[] {
	const found: string[] = [];
	collectTexts(parse(source, { modern: true }).fragment, found);
	return found;
}

const components = globSync('src/**/*.svelte').sort();
const textsIn = (file: string) => hardcodedTexts(readFileSync(file, 'utf8'));

describe('hard-coded text in components', () => {
	it('finds markup text and user-facing attributes, but not translated text or technical attributes', () => {
		expect(
			hardcodedTexts(
				'<script>let x = "skipped";</script><h1>Hallo</h1><button aria-label="Schließen" class="close">×</button>'
			)
		).toEqual(['Hallo', 'Schließen']);
		expect(
			hardcodedTexts(
				'<h1>{t("login.title")}</h1><input name="name" type="text" style:width="{n}px" />'
			)
		).toEqual([]);
	});

	it.each(components.filter((file) => !NOT_YET_MIGRATED.has(file)))(
		'%s takes its human-facing text from the catalogue',
		(file) => {
			expect(textsIn(file)).toEqual([]);
		}
	);

	it.each([...NOT_YET_MIGRATED])(
		'%s still exists and still has hard-coded text, otherwise it leaves the list',
		(file) => {
			expect(components).toContain(file);
			expect(textsIn(file)).not.toEqual([]);
		}
	);
});
