import { describe, expect, it } from 'vitest';
import { isTicketFacet, isTicketPath, openingFacet, ticketHref } from './links';

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

	it('opens on the file without an address hint and without a question', () => {
		expect(openingFacet(search(''), false)).toBe('akte');
	});

	it('opens on the open question, even when a run is named', () => {
		expect(openingFacet(search(''), true)).toBe('frage');
		expect(openingFacet(search('run=4'), true)).toBe('frage');
	});

	it('opens on the trace when a run is named', () => {
		expect(openingFacet(search('run=4'), false)).toBe('spur');
	});

	it('follows ?facet= over every default, but not to a question that is not there', () => {
		expect(openingFacet(search('facet=runs'), true)).toBe('runs');
		expect(openingFacet(search('run=4&facet=akte'), false)).toBe('akte');
		expect(openingFacet(search('facet=frage'), false)).toBe('akte');
		expect(openingFacet(search('facet=nonsense'), false)).toBe('akte');
	});
});
