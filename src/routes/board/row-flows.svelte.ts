import { SvelteSet } from 'svelte/reactivity';
import { t } from '$lib/i18n/t';
import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
import { dismiss, isHeld, toast, toastMs } from '$lib/ui/toast.svelte';
import * as actions from './board-actions';
import type { BoardTicket } from './list';

/** What the flows need from the page that owns the rows. */
export type FlowDeps = {
	reload: () => Promise<void>;
	focusRow: (id: number | undefined) => Promise<void>;
	/** Makes the row the selected one without moving the focus, for an intent a click started on another row. */
	selectQuietly: (row: BoardTicket) => void;
	plural: () => Intl.PluralRules;
};

/** The inline editors of a row and the human's intents on it. */
export class RowEditor {
	/** A refusal the domain gave for a row, shown at that row with its way out. */
	refusal = $state<{ id: number; text: string } | null>(null);
	renaming = $state<number | null>(null);
	renameTitle = $state('');
	givingBack = $state<number | null>(null);
	giveBackComment = $state('');
	readonly #deps: FlowDeps;

	constructor(deps: FlowDeps) {
		this.#deps = deps;
	}

	async retitle(row: BoardTicket, title: string) {
		const failure = await actions.retitle(row.id, title);
		if (failure) return void (this.refusal = { id: row.id, text: failure });
		this.refusal = null;
		await this.#deps.reload();
		void this.#deps.focusRow(row.id);
	}

	/** Runs one of the human's intents on the row; a refusal shows at the row, with its way out. */
	async #intend(row: BoardTicket, action: actions.Intent, fields: Record<string, string> = {}) {
		const outcome = await actions.intend(row.id, action, fields);
		if ('failure' in outcome) {
			this.refusal = { id: row.id, text: outcome.failure };
			// an open comment field keeps the focus, or the next keys would act on the row instead of the text
			if (this.givingBack !== row.id) void this.#deps.focusRow(row.id);
			return false;
		}
		this.refusal = null;
		await this.#deps.reload();
		void this.#deps.focusRow(row.id);
		return outcome.result;
	}

	async start(row: BoardTicket) {
		this.#deps.selectQuietly(row);
		const result = await this.#intend(row, 'start');
		if (!result) return;
		const waitingFor = result.type === 'success' ? (result.data?.predecessors as string[]) : [];
		toast(
			waitingFor.length
				? t(
						this.#deps.plural().select(waitingFor.length) === 'one'
							? 'board.startedBlocked.one'
							: 'board.startedBlocked.other',
						{ ref: row.ref, refs: waitingFor.join(', ') }
					)
				: t('board.started', { ref: row.ref }),
			'success'
		);
	}

	async accept(row: BoardTicket) {
		this.#deps.selectQuietly(row);
		if (await this.#intend(row, 'accept')) toast(t('board.accepted', { ref: row.ref }), 'success');
	}

	startGivingBack(row: BoardTicket) {
		this.#deps.selectQuietly(row);
		this.givingBack = row.id;
		this.giveBackComment = '';
		this.refusal = null;
	}

	cancelGivingBack(row: BoardTicket) {
		this.givingBack = null;
		void this.#deps.focusRow(row.id);
	}

	async giveBack(row: BoardTicket) {
		if (!(await this.#intend(row, 'giveBack', { comment: this.giveBackComment }))) return;
		this.givingBack = null;
		void this.#deps.focusRow(row.id);
		toast(t('board.returned', { ref: row.ref }), 'success');
	}

	startRenaming(row: BoardTicket) {
		this.renaming = row.id;
		this.renameTitle = row.title;
	}

	cancelRenaming(row: BoardTicket) {
		this.renaming = null;
		void this.#deps.focusRow(row.id);
	}

	rename(row: BoardTicket) {
		const title = this.renameTitle;
		this.renaming = null;
		if (!title.trim() || title === row.title) return void this.#deps.focusRow(row.id);
		const before = row.title;
		undoStack.perform({
			label: t('board.renamed', { ref: row.ref }),
			perform: () => void this.retitle(row, title),
			revert: () => void this.retitle(row, before)
		});
	}
}

/** Deleting with an undo window: the row goes at once, the ticket only after the window. */
export class Deletion {
	/** Deleted on the board, but still inside the undo window. */
	readonly pending = new SvelteSet<number>();
	readonly #deps: Pick<FlowDeps, 'reload' | 'focusRow'>;
	readonly #focusAfterDelete: () => number | undefined;

	constructor(
		deps: Pick<FlowDeps, 'reload' | 'focusRow'>,
		focusAfterDelete: () => number | undefined
	) {
		this.#deps = deps;
		this.#focusAfterDelete = focusAfterDelete;
	}

	async #forGood(row: BoardTicket) {
		const failure = await actions.deleteForGood(row.id);
		if (failure) toast(t('board.deleteFailed', { reason: failure }), 'error');
		else await this.#deps.reload();
		this.pending.delete(row.id);
	}

	/**
	 * dd: the row goes at once and the ticket only after the undo window, so u can still bring it back.
	 * ponytail: closing the tab inside the window keeps the ticket; a server-side delete queue would not.
	 */
	remove(row: BoardTicket) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let notice: number | undefined;
		let settled = false;
		/** How long the ticket can come back with u before it is deleted for good: the toast's window. */
		const undoMs = toastMs();
		const deleted = t('board.deleted', { ref: row.ref });
		const settle = () => {
			if (!settled) void this.#forGood(row);
			settled = true;
			clearTimeout(timer);
		};
		const action: Undoable = {
			label: deleted,
			perform: () => {
				this.pending.add(row.id);
				// a held toast outlives the timer; its expiry settles then
				timer = setTimeout(() => {
					if (!isHeld()) settle();
				}, undoMs);
				const run = () => undoStack.revert(action);
				const undo = { label: t('board.undo'), run, countdown: true, onExpire: settle };
				notice = toast(deleted, 'success', undoMs, undo);
				void this.#deps.focusRow(this.#focusAfterDelete());
			},
			revert: () => {
				if (notice !== undefined) dismiss(notice);
				if (settled)
					return void toast(
						t('board.deleteFinal', { ref: row.ref, seconds: undoMs / 1000 }),
						'error'
					);
				clearTimeout(timer);
				this.pending.delete(row.id);
				void this.#deps.focusRow(row.id);
			}
		};
		undoStack.perform(action);
	}
}
