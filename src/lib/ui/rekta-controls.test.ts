import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { FieldAttrs } from './FormField.svelte';

vi.mock('$app/state', () => ({ page: { data: { locale: 'en' } } }));
const { default: Button } = await import('./Button.svelte');
const { default: Dialog } = await import('./Dialog.svelte');
const { default: ErrorSummary } = await import('./ErrorSummary.svelte');
const { default: FormField } = await import('./FormField.svelte');

const label = createRawSnippet(() => ({ render: () => '<span>Save</span>' }));
const html = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '');
const button = (props: Record<string, unknown> = {}) =>
	html(render(Button, { props: { children: label, ...props } }).body);

describe('Button', () => {
	it.each([
		['secondary', 'rk-btn'],
		['primary', 'rk-btn rk-btn--primary'],
		['ghost', 'rk-btn rk-btn--quiet']
	])('renders the %s variant as Rekta classes', (variant, classes) => {
		expect(button({ variant })).toContain(`class="${classes}"`);
	});

	it('marks danger by Rekta status attribute, not by a colour of its own', () => {
		const danger = button({ variant: 'danger' });
		expect(danger).toContain('data-status="error"');
		expect(danger).toContain('class="rk-btn"');
		expect(button()).not.toContain('data-status');
	});

	it('has no small step: sm renders like md', () => {
		expect(button({ size: 'sm' })).toBe(button({ size: 'md' }));
	});

	it('keeps a running action focusable and announced', () => {
		const loading = button({ loading: true });
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('aria-disabled="true"');
		expect(loading).toContain('data-rk-pending');
		expect(loading).not.toMatch(/\sdisabled[\s>=]/);
	});

	it('still takes a caller class next to its own', () => {
		expect(button({ class: 'wide' })).toContain('class="rk-btn wide"');
	});
});

describe('FormField', () => {
	const field = (props: Record<string, unknown>) => {
		let attrs: FieldAttrs | undefined;
		const children = createRawSnippet((get: () => FieldAttrs) => ({
			render: () => {
				attrs = get();
				return `<input id="${attrs.id}" class="${attrs.class}"${
					attrs['aria-describedby'] ? ` aria-describedby="${attrs['aria-describedby']}"` : ''
				}${attrs['aria-invalid'] ? ' aria-invalid="true"' : ''} />`;
			}
		}));
		const out = html(render(FormField, { props: { label: 'Name', children, ...props } }).body);
		return { out, attrs: attrs! };
	};

	it('hands Rekta input class to the control and labels it', () => {
		const { out, attrs } = field({});
		expect(attrs.class).toBe('rk-input');
		expect(out).toContain('<div class="rk-field">');
		expect(out).toContain(`<label class="rk-label" for="${attrs.id}">Name</label>`);
		expect(out).not.toContain('rk-hint');
		expect(attrs['aria-describedby']).toBeUndefined();
	});

	it('shows the hint, and an error turns it into the error in the same place', () => {
		const hinted = field({ hint: 'Short and as a result.' });
		expect(hinted.out).toContain(
			`<p id="${hinted.attrs.id}-hint" class="rk-hint">Short and as a result.</p>`
		);
		expect(hinted.attrs['aria-describedby']).toBe(`${hinted.attrs.id}-hint`);

		const refused = field({ hint: 'Short and as a result.', error: 'Name taken. Choose another.' });
		expect(refused.out).toContain('data-status="error"');
		expect(refused.out).toContain(
			`<p id="${refused.attrs.id}-error" class="rk-hint">Name taken. Choose another.</p>`
		);
		expect(refused.out).not.toContain('Short and as a result.');
		expect(refused.attrs['aria-describedby']).toBe(`${refused.attrs.id}-error`);
		expect(refused.attrs['aria-invalid']).toBe('true');
	});

	it('marks optional fields in the label and required ones not at all', () => {
		expect(field({}).out).not.toContain('optional');
		expect(field({ optional: true }).out).toMatch(
			/Name\s*<span class="rk-optional">\(optional\)<\/span>/
		);
	});
});

describe('ErrorSummary', () => {
	const summary = (props: Record<string, unknown>) => html(render(ErrorSummary, { props }).body);
	const errors = [
		{ name: 'name', label: 'Name', message: 'Name taken. Choose another.' },
		{ name: 'key', label: 'Key', message: 'Use two to five capitals.' }
	];

	it('renders nothing without errors', () => {
		expect(summary({ errors: [] })).toBe('');
	});

	it('says how many fields need attention and links to each of them', () => {
		const out = summary({ errors });
		expect(out).toContain('class="rk-errors"');
		expect(out).toContain('tabindex="-1"');
		expect(out).toMatch(/aria-labelledby="([^"]+)-heading"/);
		expect(out).toContain('2 fields need attention');
		expect(out).toContain('<a href="#name"');
		expect(out).toContain('Name: Name taken. Choose another.');
		expect(out).toContain('<a href="#key"');
		expect(summary({ errors: errors.slice(0, 1) })).toContain('1 field needs attention');
	});

	it('shows a refusal of the whole form as the sentence', () => {
		const out = summary({ message: 'Could not save. Your changes are still here.' });
		expect(out).toContain('Could not save. Your changes are still here.');
		expect(out).not.toContain('<ul>');
	});
});

describe('Dialog', () => {
	const dialog = (props: Record<string, unknown>) =>
		html(render(Dialog, { props: { title: 'Cancel run?', children: label, ...props } }).body);

	it('renders the sheet variant as Rekta sheet with the title as its group heading', () => {
		const out = dialog({ variant: 'sheet' });
		expect(out).toMatch(/<dialog class="rk-sheet[ "]/);
		expect(out).toMatch(/<h2 class="rk-group[ "][^>]*id="[^"]+-title">Cancel run\?<\/h2>/);
		expect(out).not.toContain('aria-label="Schließen"');
	});

	it('keeps the centred dialog and the bar sheet, and knows no panel any more', () => {
		expect(dialog({})).toContain('class="dialog');
		expect(dialog({ variant: 'bar-sheet' })).toContain('class="bar-sheet');
	});

	it('only a dialog with unsaved input asks to close on the close request', () => {
		expect(dialog({ variant: 'sheet', dirty: true })).toContain('closedby="closerequest"');
		expect(dialog({ variant: 'sheet' })).not.toContain('closedby');
	});
});
