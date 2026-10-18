<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/t';
	import { ticketHref } from '$lib/links';
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { crossfade } from 'svelte/transition';
	import NoProject from '$lib/components/NoProject.svelte';
	import { focusSummary } from '$lib/shell/focus';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { bindKeys, type KeyHandlers } from '$lib/shell/router.svelte';
	import { bindCommands, shell, type ProjectRef } from '$lib/shell/shell.svelte';
	import { undoStack } from '$lib/shell/undo.svelte';
	import { reloadsBoard } from '$lib/ticket-live';
	import { nextMove } from '$lib/ticket-move';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { duration, easing, motionMode } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import { sideways } from '$lib/ui/sideways';
	import { toast } from '$lib/ui/toast.svelte';
	import TicketRow from './TicketRow.svelte';
	import type { PageProps } from './$types';
	import * as actions from './board-actions';
	import DraftForm from './DraftForm.svelte';
	import { Deletion, RowEditor } from './row-flows.svelte';
	import {
		BOARD_DEPENDENCY,
		FLOW_COOKIE,
		edgeIndex,
		groupByColumn,
		groupByLage,
		canAccept,
		canGiveBack,
		canStart,
		groupJump,
		sideJump,
		stepped,
		type BoardTicket
	} from './list';

	let { data }: PageProps = $props();

	const projects = $derived(data.live?.projects ?? []);
	const plural = $derived(new Intl.PluralRules(page.data.locale));

	/** The expert view with the flow's columns; the browser remembers the choice in a cookie. */
	let flowChoice = $state<boolean>();
	const flow = $derived(flowChoice ?? data.flow);

	const editor = new RowEditor({
		reload: () => reload(),
		focusRow: (id) => focusRow(id),
		selectQuietly,
		plural: () => plural
	});
	const deletion = new Deletion(
		{ reload: () => reload(), focusRow: (id) => focusRow(id) },
		() => current?.id
	);
	const present = $derived(data.tickets.filter((ticket) => !deletion.pending.has(ticket.id)));
	const view = $derived(focusSummary(present, shell.focus, (ticket) => ticket.project.id));
	/** A focused project shows the steps of its own variant only. */
	const flowColumns = $derived(
		shell.focus
			? data.columns.filter((column) => column.projectId === shell.focus?.id)
			: data.columns
	);
	const groups = $derived(
		flow
			? groupByColumn(view.visible, flowColumns)
			: groupByLage(view.visible, (lage) => t(`lage.${lage}`))
	);
	const variantsShown = $derived(new Set(groups.map((group) => group.variant)).size > 1);
	const rows = $derived(groups.flatMap((group) => group.rows));
	const groupStarts = $derived(
		groups.filter((group) => group.rows.length).map((group) => rows.indexOf(group.rows[0]))
	);

	const hiddenLine = $derived.by(() => {
		const shown = new Set(view.visible);
		const hidden = present.filter((ticket) => !shown.has(ticket));
		if (!hidden.length) return '';
		const others = new Set(hidden.map((ticket) => ticket.project.id)).size;
		const key = plural.select(others) === 'one' ? 'start.hidden.one' : 'start.hidden.other';
		return t(key, { count: hidden.length, projects: others });
	});

	/** The selected row; when it disappears, the row now at its place takes over. */
	let cursor = $state({ id: 0, index: 0 });
	const current: BoardTicket | undefined = $derived(
		rows.find((row) => row.id === cursor.id) ?? rows[Math.min(cursor.index, rows.length - 1)]
	);
	const currentIndex = $derived(current ? rows.indexOf(current) : -1);

	/** A new ticket takes the selection as soon as the load that carries it has arrived. */
	let selectWhenShown = $state<string>();
	$effect(() => {
		const index = rows.findIndex((row) => row.ref === selectWhenShown);
		if (index < 0) return;
		selectWhenShown = undefined;
		select(index);
	});

	type Draft = { anchor?: number; below: boolean; project: ProjectRef; columnId?: number };
	let draft = $state<Draft | null>(null);
	let draftTitle = $state('');
	/** Why creating the ticket failed; it shows at the field and goes with the next try or the draft. */
	let draftError = $state<string>();

	const glide = () => (motionMode() === 'reduced' ? 0 : duration.glide);
	const [send, receive] = crossfade({ duration: glide, easing: easing.inOut });

	async function focusRow(id: number | undefined) {
		await tick();
		// a row that slides to another group leaves an inert copy behind until the slide ends
		const row = document.querySelector<HTMLElement>(`[data-ticket="${id}"]:not([inert])`);
		// the browser's own focus scroll leaves a row that is only partly visible where it is
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/** A row re-rendered into another group is a new element; the old one went inert or away with the focus. */
	const focusDropped = () =>
		!document.activeElement ||
		document.activeElement === document.body ||
		document.activeElement.closest('[inert]') !== null;

	/** Loads the board again; a row that had the focus keeps it, unless the focus has moved on meanwhile. */
	async function reload() {
		const focused = document.activeElement?.closest('[data-ticket]')?.getAttribute('data-ticket');
		await invalidateLive(BOARD_DEPENDENCY);
		await tick();
		if (focused && focusDropped()) await focusRow(Number(focused));
	}

	/** Makes the row the selected one without moving the focus. */
	function selectQuietly(row: BoardTicket) {
		cursor = { id: row.id, index: rows.indexOf(row) };
	}

	function select(index: number) {
		const row = rows[index];
		if (!row) return;
		cursor = { id: row.id, index };
		editor.refusal = null;
		void focusRow(row.id);
	}

	function toggleFlow() {
		flowChoice = !flow;
		// the choice used to be kept for /board only, and that older cookie would outrank this one there
		document.cookie = `${FLOW_COOKIE}=; path=/board; max-age=0`;
		document.cookie = `${FLOW_COOKIE}=${flowChoice ? 'flow' : 'lage'}; path=/; max-age=31536000; samesite=lax`;
		void focusRow(current?.id);
	}

	/** Moves the ticket and reloads; returns the domain's refusal with its way out, if there is one. */
	async function moveTo(row: BoardTicket, columnId: number): Promise<string | undefined> {
		const failure = await actions.moveTo(row.id, columnId);
		if (!failure) await reload();
		return failure;
	}

	const moveOrSay = (row: BoardTicket, columnId: number) =>
		void moveTo(row, columnId).then((failure) => failure && toast(failure, 'error'));

	/** `>`/`<` in the expert view: the next column of the ticket's project; a refusal shows at the row. */
	async function shift(row: BoardTicket, forward: boolean) {
		editor.refusal = null;
		const columns = data.columns.filter((column) => column.projectId === row.project.id);
		const candidates = columns.map((column) => ({ ...column, columnId: column.id }));
		const target = nextMove(candidates, row.column.position, forward);
		if (!target)
			return void toast(
				t(forward ? 'board.flow.noNext' : 'board.flow.noPrevious', { ref: row.ref })
			);
		const failure = await moveTo(row, target.id);
		if (failure) return void (editor.refusal = { id: row.id, text: failure });
		const label = t('board.flow.moved', { ref: row.ref, column: target.name });
		toast(label);
		const from = row.column.id;
		undoStack.record({
			label,
			perform: () => moveOrSay(row, target.id),
			revert: () => moveOrSay(row, from)
		});
	}

	function openDraft(below: boolean) {
		const row = current;
		const project = shell.focus ?? row?.project ?? projects[0];
		if (!project) return;
		// only the expert view names a column; the Lagen create in the first step
		const sameColumn = flow && row && row.project.id === project.id && row.column.phase !== 'done';
		draft = { anchor: row?.id, below, project, columnId: sameColumn ? row.column.id : undefined };
		draftTitle = '';
		draftError = undefined;
	}

	function closeDraft() {
		draft = null;
		draftError = undefined;
		void focusRow(current?.id);
	}

	async function create(target: Draft) {
		if (!draftTitle.trim()) return closeDraft();
		draftError = undefined;
		const created = await actions.create(target.project.id, draftTitle, target.columnId);
		if ('failure' in created) return void (draftError = created.failure);
		const { ref } = created;
		draft = null;
		toast(t('board.created', { ref }), 'success');
		await reload();
		selectWhenShown = ref;
	}

	async function copyRef(row: BoardTicket) {
		try {
			await navigator.clipboard.writeText(row.ref);
			toast(t('board.copied', { ref: row.ref }), 'success');
		} catch {
			toast(t('board.copyFailed', { ref: row.ref }), 'error');
		}
	}

	const goSide = (count: number, forward: boolean) =>
		select(sideJump(groupStarts, currentIndex, forward, count));

	function rowKeys(row: BoardTicket): KeyHandlers {
		return {
			move: (count, key) =>
				select(stepped(currentIndex, key === 'j' ? count : -count, rows.length)),
			side: (count, key) => goSide(count, key === 'l'),
			edge: (count, key) => select(edgeIndex(key, count, rows.length)),
			group: (count, key) => select(groupJump(groupStarts, currentIndex, key === '}', count)),
			open: () => void goto(ticketHref(row.project.code, row.number)),
			shiftColumn: flow ? (_count, key) => void shift(row, key === '>') : undefined,
			start: canStart(row) ? () => void editor.start(row) : undefined,
			accept: canAccept(row) ? () => void editor.accept(row) : undefined,
			giveBack: canGiveBack(row) ? () => editor.startGivingBack(row) : undefined,
			editText: () => editor.startRenaming(row),
			remove: () => deletion.remove(row),
			copy: () => void copyRef(row),
			focusHere: () => (shell.focus = row.project)
		};
	}

	$effect(() => {
		const row = current;
		return bindKeys({
			add: projects.length ? (_count, key) => openDraft(key === 'o') : undefined,
			groupBy: toggleFlow,
			...(row ? rowKeys(row) : {})
		});
	});

	$effect(() =>
		bindCommands([
			{ id: 'ablauf', label: ':ablauf', detail: t('board.flow.command'), run: toggleFlow }
		])
	);

	$effect(() =>
		onLiveEvent((event) => {
			if (reloadsBoard(event)) void reload();
		})
	);

	// Arrows are not part of the keymap (a pivot's tabs use them natively), so the panorama takes them itself.
	function arrows(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !current) return;
		if ((event.target as Element | null)?.closest('input, textarea, select, dialog[open]')) return;
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		goSide(1, event.key === 'ArrowRight');
	}
</script>

<svelte:window onkeydown={arrows} />

{#snippet draftForm(target: Draft)}
	<DraftForm
		project={target.project}
		bind:title={draftTitle}
		error={draftError}
		onsubmit={() => void create(target)}
		oncancel={closeDraft}
	/>
{/snippet}

<svelte:head><title>{t('board.title')}</title></svelte:head>

<div class="board">
	<header class="board-head">
		<h1>{t('board.heading')}</h1>
		{#if projects.length}
			<p class="summary">{t('board.summary', { count: rows.length })}</p>
			<Button size="sm" aria-pressed={flow} onclick={toggleFlow}>{t('board.flow.show')}</Button>
			<Button size="sm" onclick={() => openDraft(true)}>{t('board.new')} <Kbd key="o" /></Button>
		{/if}
	</header>

	{#if !projects.length}
		<NoProject />
	{:else}
		{#if projects.length > 1}
			<div class="chips" role="group" aria-label={t('board.focus.label')}>
				<button
					class="chip"
					aria-pressed={shell.focus === null}
					onclick={() => (shell.focus = null)}>{t('board.focus.all')}</button
				>
				{#each projects as project (project.id)}
					<button
						class="chip"
						aria-pressed={shell.focus?.id === project.id}
						onclick={() => (shell.focus = project)}
						><ProjectTag code={project.code} palette={project.palette} /> {project.name}</button
					>
				{/each}
			</div>
		{/if}

		<!-- without its row (none selected, or the row went away meanwhile) a draft stands on its own -->
		{#if draft && !rows.some((row) => row.id === draft?.anchor)}{@render draftForm(draft)}{/if}

		{#if !rows.length && !draft}
			<EmptyState title={t('board.empty.title')}>
				<Kbd key="o" />
				{shell.focus
					? t('board.empty.hintIn', { project: shell.focus.name })
					: t('board.empty.hint')}
				{#snippet action()}<Button variant="primary" onclick={() => openDraft(true)}
						>{t('board.empty.action')}</Button
					>{/snippet}
			</EmptyState>
		{:else}
			<div class="panorama" data-panorama use:sideways>
				{#each groups as group, groupIndex (group.id)}
					<section
						aria-labelledby={variantsShown
							? `variant-${group.id} group-${group.id}`
							: `group-${group.id}`}
						data-group={group.id}
						class:block-start={variantsShown && group.variant !== groups[groupIndex - 1]?.variant}
					>
						{#if variantsShown && group.variant}
							<p class="variant-name" id="variant-{group.id}">
								{t(`variant.${group.variant}.name`)}
							</p>
						{/if}
						<h2 id="group-{group.id}">
							{group.title} <span class="count">{group.total}</span>
						</h2>
						<ul class="rows">
							{#each group.rows as row (row.id)}
								<li
									data-ticket={row.id}
									tabindex="-1"
									aria-current={row === current ? 'true' : undefined}
									in:receive={{ key: row.id }}
									out:send={{ key: row.id }}
									animate:flip={{ duration: glide }}
								>
									{#if draft?.anchor === row.id && !draft.below}{@render draftForm(draft)}{/if}
									<TicketRow {row} {flow} {editor} />
									{#if draft?.anchor === row.id && draft.below}{@render draftForm(draft)}{/if}
								</li>
							{/each}
						</ul>
						{#if !group.rows.length}<p class="muted">{t('board.group.empty')}</p>{/if}
						{#if group.total > group.rows.length}
							<p class="muted">
								{t('board.done.more', { shown: group.rows.length, total: group.total })}
							</p>
						{/if}
					</section>
				{/each}
			</div>
		{/if}

		{#if hiddenLine}<p class="hidden-line">{hiddenLine}</p>{/if}
	{/if}
</div>

<style>
	.board-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-3);
	}
	.board-head h1 {
		margin: 0;
	}
	.summary {
		flex: 1;
		margin: 0;
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 30px;
		padding: 0 var(--space-3);
		border: 0;
		border-radius: 15px;
		background: var(--fill-soft);
		color: inherit;
		font: inherit;
		font-size: var(--type-meta);
	}
	.chip[aria-pressed='true'] {
		background: var(--fill-sel);
		font-weight: var(--weight-medium);
	}
	.panorama {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	.panorama > section {
		min-width: 0;
	}
	.variant-name {
		margin: 0 0 var(--space-1);
		color: var(--text-muted);
		font-size: var(--type-meta);
		font-weight: var(--weight-medium);
		text-transform: uppercase;
	}
	h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--type-group);
		font-weight: var(--weight-light);
	}
	.count,
	.muted,
	.hidden-line {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.count {
		font-variant-numeric: tabular-nums;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-x: clip; /* a row sliding in must not widen the page */
	}
	.rows li {
		border-bottom: 1px solid var(--rule);
	}
	.rows li[aria-current='true'] {
		background: var(--fill-sel);
	}
	.rows li:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}

	@media (min-width: 760px) {
		/* The board is a stage like the start view: the panorama fills the room between head and app bar */
		.board {
			display: flex;
			flex-direction: column;
			height: var(--stage-h);
			margin: calc(-1 * var(--space-6)) calc(-1 * var(--gutter));
			padding-top: var(--space-4);
		}
		.board > :not(.panorama),
		.board > :global(.field-row) {
			padding-inline: var(--gutter);
		}
		.panorama {
			flex: 1;
			flex-direction: row;
			gap: 40px;
			min-height: 0;
			padding: 0 var(--gutter) var(--space-3);
			overflow: auto hidden;
			scrollbar-width: thin;
		}
		.panorama > section.block-start {
			margin-inline-start: var(--space-6);
		}
		.panorama > section {
			flex: 0 0 var(--facet-w);
			overflow-y: auto;
		}
	}
</style>
