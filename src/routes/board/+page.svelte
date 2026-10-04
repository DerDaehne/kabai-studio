<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { SvelteSet } from 'svelte/reactivity';
	import { crossfade } from 'svelte/transition';
	import NoProject from '$lib/components/NoProject.svelte';
	import { failureOf, postAction } from '$lib/form-action';
	import { focusSummary } from '$lib/shell/focus';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { bindKeys, type KeyHandlers } from '$lib/shell/router.svelte';
	import { shell, type ProjectRef } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import { reloadsBoard } from '$lib/ticket-live';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { duration, easing, motionMode } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import { dismiss, toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';
	import {
		BOARD_DEPENDENCY,
		edgeIndex,
		groupByColumn,
		groupJump,
		runStatus,
		startRule,
		stepped,
		type BoardTicket,
		type StepTarget
	} from './list';

	/** How long a deleted ticket can come back with u before it is deleted for good. */
	const DELETE_UNDO_MS = 10_000;

	let { data }: PageProps = $props();

	const projects = $derived(data.live?.projects ?? []);
	const runs = $derived(data.live?.runs ?? []);
	/** Deleted on the board, but still inside the undo window. */
	const deleting = new SvelteSet<number>();
	const view = $derived(
		focusSummary(
			data.tickets.filter((ticket) => !deleting.has(ticket.id)),
			shell.focus,
			(ticket) => ticket.project.id
		)
	);
	const groups = $derived(groupByColumn(view.visible));
	const rows = $derived(groups.flatMap((group) => group.rows));
	const groupStarts = $derived(groups.map((group) => rows.indexOf(group.rows[0])));

	/** The selected row; when it disappears, the row now at its place takes over. */
	let cursor = $state({ id: 0, index: 0 });
	const current = $derived(
		rows.find((row) => row.id === cursor.id) ?? rows[Math.min(cursor.index, rows.length - 1)]
	);
	const currentIndex = $derived(current ? rows.indexOf(current) : -1);

	type Draft = { anchor?: number; below: boolean; project: ProjectRef; columnId?: number };
	let draft = $state<Draft | null>(null);
	let draftTitle = $state('');
	let renaming = $state<number | null>(null);
	let renameTitle = $state('');

	const glide = () => (motionMode() === 'reduced' ? 0 : duration.glide);
	const [send, receive] = crossfade({ duration: glide, easing: easing.inOut });

	const href = (row: BoardTicket) => `/p/${row.project.code}/t/${row.number}`;
	const reload = () => invalidateLive(BOARD_DEPENDENCY);

	async function focusRow(id: number | undefined) {
		await tick();
		// a row that slides to another column leaves an inert copy behind until the slide ends
		document.querySelector<HTMLElement>(`[data-ticket="${id}"]:not([inert])`)?.focus();
	}

	function select(index: number) {
		const row = rows[index];
		if (!row) return;
		cursor = { id: row.id, index };
		void focusRow(row.id);
	}

	async function moveTo(
		row: BoardTicket,
		target: Pick<StepTarget, 'columnId' | 'name'>,
		notice = ''
	) {
		const fields = { ticketId: String(row.id), columnId: String(target.columnId) };
		const failure = failureOf(await postAction('/board?/move', fields));
		if (failure) return void toast(failure, 'error');
		if (notice) toast(notice);
		await reload();
		void focusRow(row.id);
	}

	/** `>`/`<`: one allowed column on; a closed one says why and what to do instead. */
	function shift(row: BoardTicket, forward: boolean) {
		const target = forward ? row.next.forward : row.next.back;
		if (!target) return void toast(`Keine ${forward ? 'nächste' : 'vorige'} Spalte erreichbar.`);
		const [blocker] = target.blockers;
		if (blocker) return void toast(`${blocker.message} ${blocker.hint}`, 'error');
		const from = { columnId: row.column.id, name: row.column.name };
		undoStack.perform({
			label: `${row.ref} nach ${target.name}`,
			perform: () => void moveTo(row, target, `${row.ref} nach ${target.name}`),
			revert: () => void moveTo(row, from)
		});
	}

	function openDraft(below: boolean) {
		const row = current;
		const project = shell.focus ?? row?.project ?? projects[0];
		if (!project) return;
		const sameColumn = row && row.project.id === project.id && row.column.kind !== 'done';
		draft = { anchor: row?.id, below, project, columnId: sameColumn ? row.column.id : undefined };
		draftTitle = '';
	}

	function closeDraft() {
		draft = null;
		void focusRow(current?.id);
	}

	async function create(target: Draft) {
		if (!draftTitle.trim()) return closeDraft();
		const fields: Record<string, string> = {
			projectId: String(target.project.id),
			title: draftTitle
		};
		if (target.columnId) fields.columnId = String(target.columnId);
		const result = await postAction('/board?/create', fields);
		const failure = failureOf(result);
		if (failure) return void toast(failure, 'error');
		const ref = result.type === 'success' ? String(result.data?.ref) : '';
		draft = null;
		toast(`${ref} angelegt`, 'success');
		await reload();
		select(rows.findIndex((row) => row.ref === ref));
	}

	async function retitle(row: BoardTicket, title: string) {
		const failure = failureOf(
			await postAction('/board?/rename', { ticketId: String(row.id), title })
		);
		if (failure) return void toast(failure, 'error');
		await reload();
		void focusRow(row.id);
	}

	function startRenaming(row: BoardTicket) {
		renaming = row.id;
		renameTitle = row.title;
	}

	function cancelRenaming(row: BoardTicket) {
		renaming = null;
		void focusRow(row.id);
	}

	function rename(row: BoardTicket) {
		const title = renameTitle;
		renaming = null;
		if (!title.trim() || title === row.title) return void focusRow(row.id);
		const before = row.title;
		undoStack.perform({
			label: `${row.ref} umbenannt`,
			perform: () => void retitle(row, title),
			revert: () => void retitle(row, before)
		});
	}

	const finalNotice = (row: BoardTicket) =>
		`${row.ref} ist schon endgültig gelöscht; Rückgängig geht nur in den ersten ${DELETE_UNDO_MS / 1000} s.`;

	async function deleteForGood(row: BoardTicket) {
		const failure = failureOf(await postAction('/board?/delete', { ticketId: String(row.id) }));
		if (failure) toast(`Löschen ging nicht: ${failure}`, 'error');
		else await reload();
		deleting.delete(row.id);
	}

	/**
	 * dd: the row goes at once and the ticket only after the undo window, so u can still bring it back.
	 * ponytail: closing the tab inside the window keeps the ticket; a server-side delete queue would not.
	 */
	function remove(row: BoardTicket) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let notice: number | undefined;
		const action: Undoable = {
			label: `${row.ref} gelöscht`,
			perform: () => {
				deleting.add(row.id);
				timer = setTimeout(() => {
					timer = undefined;
					void deleteForGood(row);
				}, DELETE_UNDO_MS);
				const undo = { label: 'Rückgängig', run: () => undoStack.revert(action) };
				notice = toast(`${row.ref} gelöscht`, 'success', DELETE_UNDO_MS, undo);
				void focusRow(current?.id);
			},
			revert: () => {
				if (notice !== undefined) dismiss(notice);
				if (timer === undefined) return void toast(finalNotice(row), 'error');
				clearTimeout(timer);
				timer = undefined;
				deleting.delete(row.id);
				void focusRow(row.id);
			}
		};
		undoStack.perform(action);
	}

	async function copyRef(row: BoardTicket) {
		try {
			await navigator.clipboard.writeText(row.ref);
			toast(`${row.ref} kopiert`, 'success');
		} catch {
			toast(`Kopieren erlaubt der Browser hier nicht. Die ID zum Abschreiben: ${row.ref}`, 'error');
		}
	}

	function rowKeys(row: BoardTicket): KeyHandlers {
		return {
			move: (count, key) =>
				select(stepped(currentIndex, key === 'j' ? count : -count, rows.length)),
			edge: (count, key) => select(edgeIndex(key, count, rows.length)),
			group: (count, key) => select(groupJump(groupStarts, currentIndex, key === '}', count)),
			open: () => void goto(href(row)),
			shiftColumn: (_count, key) => shift(row, key === '>'),
			editText: () => startRenaming(row),
			remove: () => remove(row),
			copy: () => void copyRef(row),
			focusHere: () => (shell.focus = row.project)
		};
	}

	$effect(() => {
		const row = current;
		return bindKeys({
			add: projects.length ? (_count, key) => openDraft(key === 'o') : undefined,
			...(row ? rowKeys(row) : {})
		});
	});

	$effect(() =>
		onLiveEvent((event) => {
			if (reloadsBoard(event)) void reload();
		})
	);

	/** Escape leaves the field, so the board's keys work again. */
	const escapeTo = (leave: () => void) => (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		leave();
	};
	const focusField = (input: HTMLInputElement) => {
		input.focus();
		input.select();
	};
</script>

{#snippet draftForm(target: Draft)}
	<form
		class="field-row"
		onsubmit={(event) => {
			event.preventDefault();
			void create(target);
		}}
	>
		<ProjectTag code={target.project.code} palette={target.project.palette} />
		<input
			aria-label="Titel des neuen Tickets in {target.project.name}"
			placeholder="Titel des neuen Tickets"
			autocomplete="off"
			bind:value={draftTitle}
			onkeydown={escapeTo(closeDraft)}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">Anlegen</Button>
		<span class="hint"><Kbd key="Enter" /> anlegen · <Kbd key="Escape" /> verwerfen</span>
	</form>
{/snippet}

{#snippet renameForm(row: BoardTicket)}
	<form
		class="field-row rename"
		onsubmit={(event) => {
			event.preventDefault();
			rename(row);
		}}
	>
		<input
			aria-label="Neuer Titel für {row.ref}"
			autocomplete="off"
			bind:value={renameTitle}
			onkeydown={escapeTo(() => cancelRenaming(row))}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">Speichern</Button>
	</form>
{/snippet}

{#snippet ticketRow(row: BoardTicket)}
	{@const status = runStatus(row.ref, runs)}
	<div class="row">
		<span class="id"
			><ProjectTag code={row.project.code} palette={row.project.palette} /> {row.ref}</span
		>
		{#if renaming === row.id}
			{@render renameForm(row)}
		{:else}
			<a class="title" href={href(row)}>{row.title}</a>
		{/if}
		<span class="run"
			>{#if status}<Badge tone={status.tone}>{status.text}</Badge>{/if}</span
		>
		<span class="tasks"
			>{#if row.tasks.total}{row.tasks.done}/{row.tasks.total}<span class="visually-hidden">
					Tasks erledigt</span
				>{/if}</span
		>
		<span class="epic"
			>{#if row.epic}Epic {row.epic}{/if}</span
		>
		<span class="project">{row.project.name}</span>
	</div>
{/snippet}

<svelte:head><title>Board – kabai studio</title></svelte:head>

<header class="board-head">
	<h1>Board</h1>
	{#if projects.length}
		<p class="summary">{rows.length} Tickets · je Spalte nach Nummer</p>
		<Button size="sm" onclick={() => openDraft(true)}>Neues Ticket <Kbd key="o" /></Button>
	{/if}
</header>

{#if !projects.length}
	<NoProject />
{:else}
	{#if projects.length > 1}
		<div class="chips" role="group" aria-label="Projekt-Fokus">
			<button class="chip" aria-pressed={shell.focus === null} onclick={() => (shell.focus = null)}
				>Alle</button
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

	{#each groups as group (group.column.name)}
		{@const role = data.roles[group.column.id]}
		<section class="group" aria-labelledby="group-{group.column.id}">
			<header>
				<h2 id="group-{group.column.id}">
					{group.column.name} <span class="count">{group.rows.length}</span>
				</h2>
				<p class="rule">
					{startRule(group.column.kind)}{#if role}{' · '}<span class="role">{role}</span>{/if}
				</p>
			</header>
			<ul class="rows">
				{#each group.rows as row (row.id)}
					<li
						data-ticket={row.id}
						tabindex="-1"
						aria-current={row === current ? 'true' : undefined}
						in:receive|global={{ key: row.id }}
						out:send|global={{ key: row.id }}
						animate:flip={{ duration: glide }}
					>
						{#if draft?.anchor === row.id && !draft.below}{@render draftForm(draft)}{/if}
						{@render ticketRow(row)}
						{#if draft?.anchor === row.id && draft.below}{@render draftForm(draft)}{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	{#if !rows.length && !draft}
		<EmptyState title="Noch kein Ticket">
			<Kbd key="o" /> legt eins an{shell.focus ? ` in ${shell.focus.name}` : ''}.
			{#snippet action()}<Button variant="primary" onclick={() => openDraft(true)}
					>Ticket anlegen</Button
				>{/snippet}
		</EmptyState>
	{/if}

	{#if view.hiddenLabel}<p class="hidden-line">{view.hiddenLabel}</p>{/if}
{/if}

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
		font-size: var(--text-sm);
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
		font-size: var(--text-sm);
	}
	.chip[aria-pressed='true'] {
		background: var(--fill-sel);
		font-weight: 650;
	}
	.group {
		margin-bottom: var(--space-4);
		padding: var(--space-2);
		border-radius: var(--radius-lg);
		background: var(--glass-card);
		backdrop-filter: blur(var(--blur-card)) saturate(var(--glass-sat));
		box-shadow: var(--shadow-card);
	}
	.group header {
		padding: var(--space-1) var(--space-2) var(--space-2);
	}
	.group h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.count {
		color: var(--text-muted);
		font: 500 var(--text-sm) var(--font-mono);
	}
	.rule {
		display: -webkit-box;
		margin: 0;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-sm);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 1;
		line-clamp: 1;
	}
	.rows {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rows li {
		border-radius: var(--radius-base);
	}
	.rows li[aria-current='true'] {
		background: var(--fill-sel);
	}
	.row {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr) auto 3.5rem minmax(0, 7rem) minmax(0, 8rem);
		align-items: center;
		gap: var(--space-3);
		min-height: 36px;
		padding: 0 var(--space-2);
	}
	.id {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 500 var(--text-sm) var(--font-mono);
		white-space: nowrap;
	}
	.title {
		overflow: hidden;
		color: inherit;
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title:hover {
		text-decoration: underline;
	}
	.tasks {
		color: var(--text-muted);
		font: var(--text-sm) var(--font-mono);
		text-align: right;
	}
	.epic,
	.project {
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.field-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
	}
	.field-row input {
		flex: 1;
		min-width: 0;
		height: 28px;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-base);
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.field-row.rename {
		padding: 0;
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.hidden-line {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	@media (max-width: 719px) {
		.row {
			grid-template-columns: auto minmax(0, 1fr) auto;
			padding: var(--space-1) var(--space-2);
		}
		.title {
			white-space: normal;
			overflow-wrap: anywhere;
		}
		.run {
			grid-column: 2 / -1;
			grid-row: 2;
		}
		.run:empty {
			display: none;
		}
		.epic,
		.project,
		.hint {
			display: none;
		}
	}
</style>
