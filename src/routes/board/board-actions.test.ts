import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postAction } from '$lib/form-action';
import { create, deleteForGood, intend, moveTo, retitle } from './board-actions';

vi.mock('$lib/form-action', async (original) => ({
	...(await original<typeof import('$lib/form-action')>()),
	postAction: vi.fn()
}));

const post = vi.mocked(postAction);
const refusal = {
	type: 'failure',
	status: 400,
	data: { message: 'Nicht jetzt. Zieh es erst nach Bereit.' }
} as const;

beforeEach(() => post.mockReset());

describe('board actions', () => {
	it('turns a domain refusal into its message with the way out', async () => {
		post.mockResolvedValue(refusal);
		expect(await moveTo(7, 3)).toBe(refusal.data.message);
		expect(await retitle(7, 'New')).toBe(refusal.data.message);
		expect(await deleteForGood(7)).toBe(refusal.data.message);
		expect(await intend(7, 'start')).toEqual({ failure: refusal.data.message });
		expect(await create(1, 'New')).toEqual({ failure: refusal.data.message });
	});

	it('turns a transport error into advice to reload', async () => {
		post.mockResolvedValue({ type: 'error', error: new Error('offline') });
		expect(await moveTo(7, 3)).toMatch(/Lade die Seite neu/);
	});

	it('posts the ticket and column of a move', async () => {
		post.mockResolvedValue({ type: 'success', status: 200, data: {} });
		expect(await moveTo(7, 3)).toBeUndefined();
		expect(post).toHaveBeenCalledWith('/board?/move', { ticketId: '7', columnId: '3' });
	});

	it('returns the ref of a created ticket and names the column only when given', async () => {
		post.mockResolvedValue({ type: 'success', status: 200, data: { ref: 'STU-9' } });
		expect(await create(1, 'New', 4)).toEqual({ ref: 'STU-9' });
		expect(post).toHaveBeenCalledWith('/board?/create', {
			projectId: '1',
			title: 'New',
			columnId: '4'
		});
		await create(1, 'New');
		expect(post).toHaveBeenLastCalledWith('/board?/create', { projectId: '1', title: 'New' });
	});

	it('hands back the result of an intent with its extra fields', async () => {
		const result = { type: 'success', status: 200, data: { predecessors: [] } } as const;
		post.mockResolvedValue(result);
		expect(await intend(7, 'giveBack', { comment: 'why' })).toEqual({ result });
		expect(post).toHaveBeenCalledWith('/board?/giveBack', { ticketId: '7', comment: 'why' });
	});
});
