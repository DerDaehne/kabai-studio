// Renders the shared +error.svelte server-side; $app/state's `page` is mocked so each case can set status,
// error and the matched route without a real navigation.
import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';

vi.mock('$app/state', () => ({
	page: {
		status: 404,
		error: null as { message: string } | null,
		route: { id: null as string | null }
	}
}));

const { page } = await import('$app/state');
const Page = (await import('./+error.svelte')).default;

const html = () => render(Page, { props: {} }).body;

it('shows the generic "not built" text only for a truly unknown address (no route matched)', () => {
	Object.assign(page, { status: 404, error: null, route: { id: null } });
	const body = html();
	expect(body).toContain('Die Adresse ist falsch');
});

it('shows the real error message once a route matched, e.g. an unknown ticket, with a way back to the board', () => {
	Object.assign(page, {
		status: 404,
		error: { message: 'Ticket STU-999 gibt es nicht.' },
		route: { id: '/p/[key]/t/[number]' }
	});
	const body = html();
	expect(body).toContain('Ticket STU-999 gibt es nicht.');
	expect(body).not.toContain('ist noch nicht gebaut');
	expect(body).toContain('Zum Board');
});

it('leaves out the board link for a 404 that is not about a ticket route', () => {
	Object.assign(page, {
		status: 404,
		error: { message: 'Seite X nicht gefunden.' },
		route: { id: '/x' }
	});
	const body = html();
	expect(body).toContain('Seite X nicht gefunden.');
	expect(body).not.toContain('Zum Board');
});

it('shows the plain error message for a non-404 error on a matched route', () => {
	Object.assign(page, {
		status: 500,
		error: { message: 'Kaputt.' },
		route: { id: '/p/[key]/t/[number]' }
	});
	expect(html()).toContain('Kaputt.');
});
