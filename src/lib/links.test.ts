import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTicketFacet, isTicketPath, openingFacet, refNumber, ticketHref } from './links';

describe('ticketHref', () => {
	it('is the bare path without options', () => {
		expect(ticketHref('STU', 12)).toBe('/p/STU/t/12');
		expect(ticketHref('STU', '12', {})).toBe('/p/STU/t/12');
	});

	it('adds the run and the facet as query', () => {
		expect(ticketHref('STU', 12, { run: 7 })).toBe('/p/STU/t/12?run=7');
		expect(ticketHref('STU', 12, { facet: 'akte' })).toBe('/p/STU/t/12?facet=akte');
		expect(ticketHref('STU', 12, { run: 7, facet: 'spur' })).toBe('/p/STU/t/12?run=7&facet=spur');
	});

	it('leaves out a run that is null or missing', () => {
		expect(ticketHref('STU', 12, { run: null })).toBe('/p/STU/t/12');
	});

	it('is recognised by isTicketPath, with or without query', () => {
		const path = ticketHref('STU', 12, { run: 7, facet: 'runs' }).split('?')[0];
		expect(isTicketPath(path)).toBe(true);
		expect(isTicketPath('/p/STU')).toBe(false);
		expect(isTicketPath('/board')).toBe(false);
	});
});

describe('isTicketFacet', () => {
	it('accepts the four facets and nothing else', () => {
		expect(['frage', 'spur', 'akte', 'runs'].every(isTicketFacet)).toBe(true);
		expect(isTicketFacet('lage')).toBe(false);
		expect(isTicketFacet(null)).toBe(false);
	});
});

describe('openingFacet', () => {
	const search = (query: string) => new URLSearchParams(query);
	const bare = { hasQuestion: false, hasRuns: false };

	it('opens on the file while the ticket has no run and no question', () => {
		expect(openingFacet(search(''), bare)).toBe('akte');
	});

	it('opens on the open question, even when a run is named or exists', () => {
		const asking = { hasQuestion: true, hasRuns: true };
		expect(openingFacet(search(''), asking)).toBe('frage');
		expect(openingFacet(search('run=4'), asking)).toBe('frage');
	});

	it('opens on the trace once the ticket has a run, or a run is named', () => {
		expect(openingFacet(search(''), { ...bare, hasRuns: true })).toBe('spur');
		expect(openingFacet(search('run=4'), bare)).toBe('spur');
	});

	it('follows ?facet= over every default, but not to a question that is not there', () => {
		expect(openingFacet(search('facet=runs'), { hasQuestion: true, hasRuns: true })).toBe('runs');
		expect(openingFacet(search('run=4&facet=akte'), bare)).toBe('akte');
		expect(openingFacet(search('facet=frage'), bare)).toBe('akte');
		expect(openingFacet(search('facet=nonsense'), bare)).toBe('akte');
	});
});

describe('the address of a ticket', () => {
	it('is built in links.ts only, so a change of the address touches one file', () => {
		const builders = globSync('src/**/*.{ts,svelte}')
			.filter((file) => !file.endsWith('src/lib/links.ts') && !file.endsWith('.test.ts'))
			.filter((file) => /\/p\/[^`'"\s]*\/t\//.test(readFileSync(file, 'utf8')));
		expect(builders).toEqual([]);
	});
});

describe('refNumber', () => {
	it('is the part of a ref after the last hyphen', () => {
		expect(refNumber('STU-12')).toBe('12');
		expect(refNumber('WEB-3')).toBe('3');
	});
});
