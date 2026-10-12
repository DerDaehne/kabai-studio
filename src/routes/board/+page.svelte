<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/t';
	import type { MessageKey } from '$lib/i18n';
	import type { Lage } from '$lib/lage';
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { SvelteSet } from 'svelte/reactivity';
	import { crossfade } from 'svelte/transition';
	import NoProject from '$lib/components/NoProject.svelte';
	import { failureOf, postAction } from '$lib/form-action';
	import { focusSummary } from '$lib/shell/focus';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { bindKeys, type KeyHandlers } from '$lib/shell/router.svelte';
	import { bindCommands, shell, type ProjectRef } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import { reloadsBoard } from '$lib/ticket-live';
	import { nextMove } from '$lib/ticket-move';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { duration, easing, motionMode } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import type { Tone } from '$lib/ui/rekta/tone';
	import { sideways } from '$lib/ui/sideways';
	import { dismiss, toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';
	import {
		BOARD_DEPENDENCY,
		FLOW_COOKIE,
		edgeIndex,
		groupByColumn,
		groupByLage,
		groupJump,
		sideJump,
		stepped,
		type BoardTicket
	} from './list';

	const LAGE_TONES: Record<Lage, Tone> = {
		waiting: 'warning',
		working: 'info',
		open: 'neutral',
		acceptance: 'neutral',
		done: 'success'
	};

	/** The waiting reason of an open ticket, or what a waiting one needs from the human; empty for the other Lagen. */
	function reasonText({ lage, reason }: BoardTicket) {
		if (reason.kind === 'capacity')
			return reason.causes
				.map(({ code, ...params }) => t(`lage.wait.${code}` as MessageKey, params))
				.join(', ');
		if (lage !== 'waiting' && lage !== 'open') return '';
		const refs = reason.kind === 'predecessors' ? reason.refs.join(', ') : '';
		return t(`lage.reason.${reason.kind}` as MessageKey, { refs });
	}

	/** The Lage as a word with its reason, so colour never carries the state alone. */
	function lageText(row: BoardTicket) {
		const reason = reasonText(row);
		return reason ? `${t(`lage.${row.lage}`)} · ${reason}` : t(`lage.${row.lage}`);
	}

	/** Where the ticket stands, in everyday words; a step with a working agent says so. */
	const stepText = (row: BoardTicket) =>
		row.lage === 'working' && row.column.phase === 'work'
			? t(`board.step.${row.step}.working` as MessageKey)
			: t(`board.step.${row.step}` as MessageKey);

	const RUN_WORDS: Record<NonNullable<BoardTicket['run']>['state'], MessageKey> = {
		queued: 'start.state.queued',
		running: 'start.state.running',
		waiting_approval: 'start.state.waiting',
		paused: 'start.state.paused',
		succeeded: 'start.state.succeeded',
		failed: 'start.state.failed',
		cancelled: 'start.state.cancelled'
	};

	/** How long a deleted ticket can come back with u before it is deleted for good. */
	const DELETE_UNDO_MS = 10_000;

	let { data }: PageProps = $props();

	const projects = $derived(data.live?.projects ?? []);
	const plural = $derived(new Intl.PluralRules(page.data.locale));

	/** The expert view with the flow's columns; the browser remembers the choice in a cookie. */
	let flowChoice = $state<boolean>();
	const flow = $derived(flowChoice ?? data.flow);

	/** Deleted on the board, but still inside the undo window. */
	const deleting = new SvelteSet<number>();
	const present = $derived(data.tickets.filter((ticket) => !deleting.has(ticket.id)));
	const view = $derived(focusSummary(present, shell.focus, (ticket) => ticket.project.id));
	const groups = $derived(
		flow
			? groupByColumn(view.visible, data.columns)
			: groupByLage(view.visible, (lage) => t(`lage.${lage}`))
	);
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
	const current = $derived(
		rows.find((row) => row.id === cursor.id) ?? rows[Math.min(cursor.index, rows.length - 1)]
	);
	const currentIndex = $derived(current ? rows.indexOf(current) : -1);

	/** A move the domain refused, shown at its row with the way out. */
	let refusal = $state<{ id: number; text: string } | null>(null);

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
	let renaming = $state<number | null>(null);
	let renameTitle = $state('');
	let givingBack = $state<number | null>(null);
	let giveBackComment = $state('');

	const glide = () => (motionMode() === 'reduced' ? 0 : duration.glide);
	const [send, receive] = crossfade({ duration: glide, easing: easing.inOut });

	const href = (row: BoardTicket) => `/p/${row.project.code}/t/${row.number}`;

	async function focusRow(id: number | undefined) {
		await tick();
		// a row that slides to another group leaves an inert copy behind until the slide ends
		document.querySelector<HTMLElement>(`[data-ticket="${id}"]:not([inert])`)?.focus();
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

	function select(index: number) {
		const row = rows[index];
		if (!row) return;
		cursor = { id: row.id, index };
		refusal = null;
		void focusRow(row.id);
	}

	function toggleFlow() {
		flowChoice = !flow;
		document.cookie = `${FLOW_COOKIE}=${flowChoice ? 'flow' : 'lage'}; path=/board; max-age=31536000; samesite=lax`;
		void focusRow(current?.id);
	}

	/** Moves the ticket; returns the domain's refusal with its way out, if there is one. */
	async function moveTo(row: BoardTicket, columnId: number): Promise<string | undefined> {
		const fields = { ticketId: String(row.id), columnId: String(columnId) };
		const failure = failureOf(await postAction('/board?/move', fields));
		if (!failure) await reload();
		return failure;
	}

	const moveOrSay = (row: BoardTicket, columnId: number) =>
		void moveTo(row, columnId).then((failure) => failure && toast(failure, 'error'));

	/** `>`/`<` in the expert view: the next column of the ticket's project; a refusal shows at the row. */
	async function shift(row: BoardTicket, forward: boolean) {
		refusal = null;
		const columns = data.columns.filter((column) => column.projectId === row.project.id);
		const candidates = columns.map((column) => ({ ...column, columnId: column.id }));
		const target = nextMove(candidates, row.column.position, forward);
		if (!target)
			return void toast(
				t(forward ? 'board.flow.noNext' : 'board.flow.noPrevious', { ref: row.ref })
			);
		const failure = await moveTo(row, target.id);
		if (failure) return void (refusal = { id: row.id, text: failure });
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
		toast(t('board.created', { ref }), 'success');
		await reload();
		selectWhenShown = ref;
	}

	async function retitle(row: BoardTicket, title: string) {
		const failure = failureOf(
			await postAction('/board?/rename', { ticketId: String(row.id), title })
		);
		if (failure) return void toast(failure, 'error');
		await reload();
		void focusRow(row.id);
	}

	/** Runs one of the human's intents on the row; a refusal shows at the row, with its way out. */
	async function intend(
		row: BoardTicket,
		action: 'start' | 'accept' | 'giveBack',
		fields: Record<string, string> = {}
	) {
		const result = await postAction(`/board?/${action}`, { ticketId: String(row.id), ...fields });
		const failure = failureOf(result);
		if (failure) {
			refusal = { id: row.id, text: failure };
			// an open comment field keeps the focus, or the next keys would act on the row instead of the text
			if (givingBack !== row.id) void focusRow(row.id);
			return false;
		}
		refusal = null;
		await reload();
		void focusRow(row.id);
		return result;
	}

	async function start(row: BoardTicket) {
		selectQuietly(row);
		const result = await intend(row, 'start');
		if (!result) return;
		const waitingFor = result.type === 'success' ? (result.data?.predecessors as string[]) : [];
		toast(
			waitingFor.length
				? t(
						plural.select(waitingFor.length) === 'one'
							? 'board.startedBlocked.one'
							: 'board.startedBlocked.other',
						{ ref: row.ref, refs: waitingFor.join(', ') }
					)
				: t('board.started', { ref: row.ref }),
			'success'
		);
	}

	async function accept(row: BoardTicket) {
		selectQuietly(row);
		if (await intend(row, 'accept')) toast(t('board.accepted', { ref: row.ref }), 'success');
	}

	/** Makes the row the selected one without moving the focus, for an intent a click started on another row. */
	function selectQuietly(row: BoardTicket) {
		cursor = { id: row.id, index: rows.indexOf(row) };
	}

	function startGivingBack(row: BoardTicket) {
		selectQuietly(row);
		givingBack = row.id;
		giveBackComment = '';
		refusal = null;
	}

	function cancelGivingBack(row: BoardTicket) {
		givingBack = null;
		void focusRow(row.id);
	}

	async function giveBack(row: BoardTicket) {
		if (!(await intend(row, 'giveBack', { comment: giveBackComment }))) return;
		givingBack = null;
		void focusRow(row.id);
		toast(t('board.returned', { ref: row.ref }), 'success');
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
			label: t('board.renamed', { ref: row.ref }),
			perform: () => void retitle(row, title),
			revert: () => void retitle(row, before)
		});
	}

	async function deleteForGood(row: BoardTicket) {
		const failure = failureOf(await postAction('/board?/delete', { ticketId: String(row.id) }));
		if (failure) toast(t('board.deleteFailed', { reason: failure }), 'error');
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
		const deleted = t('board.deleted', { ref: row.ref });
		const action: Undoable = {
			label: deleted,
			perform: () => {
				deleting.add(row.id);
				timer = setTimeout(() => {
					timer = undefined;
					void deleteForGood(row);
				}, DELETE_UNDO_MS);
				const undo = { label: t('board.undo'), run: () => undoStack.revert(action) };
				notice = toast(deleted, 'success', DELETE_UNDO_MS, undo);
				void focusRow(current?.id);
			},
			revert: () => {
				if (notice !== undefined) dismiss(notice);
				if (timer === undefined)
					return void toast(
						t('board.deleteFinal', { ref: row.ref, seconds: DELETE_UNDO_MS / 1000 }),
						'error'
					);
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
			toast(t('board.copied', { ref: row.ref }), 'success');
		} catch {
			toast(t('board.copyFailed', { ref: row.ref }), 'error');
		}
	}

	const goSide = (count: number, forward: boolean) =>
		select(sideJump(groupStarts, currentIndex, forward, count));

	const canStart = ({ column }: BoardTicket) => column.phase === 'open' || column.phase === 'work';
	const canAccept = ({ column }: BoardTicket) => column.phase === 'acceptance';
	const canGiveBack = ({ column }: BoardTicket) =>
		column.phase === 'acceptance' || column.phase === 'done';

	function rowKeys(row: BoardTicket): KeyHandlers {
		return {
			move: (count, key) =>
				select(stepped(currentIndex, key === 'j' ? count : -count, rows.length)),
			side: (count, key) => goSide(count, key === 'l'),
			edge: (count, key) => select(edgeIndex(key, count, rows.length)),
			group: (count, key) => select(groupJump(groupStarts, currentIndex, key === '}', count)),
			open: () => void goto(href(row)),
			shiftColumn: flow ? (_count, key) => void shift(row, key === '>') : undefined,
			start: canStart(row) ? () => void start(row) : undefined,
			accept: canAccept(row) ? () => void accept(row) : undefined,
			giveBack: canGiveBack(row) ? () => startGivingBack(row) : undefined,
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

<svelte:window onkeydown={arrows} />

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
			aria-label={t('board.draft.label', { project: target.project.name })}
			placeholder={t('board.draft.placeholder')}
			autocomplete="off"
			bind:value={draftTitle}
			onkeydown={escapeTo(closeDraft)}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">{t('board.draft.create')}</Button>
		<span class="hint"
			><Kbd key="Enter" />
			{t('board.draft.hintCreate')} · <Kbd key="Escape" />
			{t('board.draft.hintDiscard')}</span
		>
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
			aria-label={t('board.rename.label', { ref: row.ref })}
			autocomplete="off"
			bind:value={renameTitle}
			onkeydown={escapeTo(() => cancelRenaming(row))}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">{t('board.rename.save')}</Button>
	</form>
{/snippet}

{#snippet giveBackForm(row: BoardTicket)}
	<form
		class="field-row give-back"
		onsubmit={(event) => {
			event.preventDefault();
			void giveBack(row);
		}}
	>
		<input
			aria-label={t('board.giveBack.label', { ref: row.ref })}
			placeholder={t('board.giveBack.placeholder')}
			autocomplete="off"
			bind:value={giveBackComment}
			onkeydown={escapeTo(() => cancelGivingBack(row))}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">{t('board.giveBack.send')}</Button>
		<span class="hint"
			><Kbd key="Enter" />
			{t('board.giveBack.hintSend')} · <Kbd key="Escape" />
			{t('board.giveBack.hintDiscard')}</span
		>
	</form>
{/snippet}

{#snippet intents(row: BoardTicket)}
	<span class="intents" role="group" aria-label={t('board.intents.label', { ref: row.ref })}>
		{#if row.reason.kind === 'question'}
			<Button size="sm" onclick={() => void goto(href(row))}
				>{t('board.intent.answer')} <Kbd key="Enter" /></Button
			>
		{:else if canStart(row)}
			<Button size="sm" onclick={() => void start(row)}
				>{t('board.intent.start')} <Kbd key="s" /></Button
			>
		{/if}
		{#if canAccept(row)}
			<Button size="sm" onclick={() => void accept(row)}
				>{t('board.intent.accept')} <Kbd key="a" /></Button
			>
		{/if}
		{#if canGiveBack(row)}
			<Button size="sm" onclick={() => startGivingBack(row)}
				>{t('board.intent.giveBack')} <Kbd key="r" /></Button
			>
		{/if}
	</span>
{/snippet}

{#snippet lageMeta(row: BoardTicket)}
	<span class="track" role="img" aria-label={t('board.progress', row.progress)}>
		{#each { length: row.progress.total }, step}<span
				class="dot"
				class:filled={step < row.progress.index}
			></span>{/each}
	</span>
	<span class="step">{stepText(row)}</span>
	{#if reasonText(row)}
		<Tag tone={row.reason.kind === 'failure' ? 'error' : LAGE_TONES[row.lage]}
			><span class="reason">{reasonText(row)}</span></Tag
		>
	{/if}
{/snippet}

{#snippet flowMeta(row: BoardTicket)}
	<Tag tone={LAGE_TONES[row.lage]}><span class="reason">{lageText(row)}</span></Tag>
	{#if row.run}
		<span class="run"
			>{row.run.profile
				? t('board.run.profile', { state: t(RUN_WORDS[row.run.state]), profile: row.run.profile })
				: t(RUN_WORDS[row.run.state])}</span
		>
	{/if}
	{#if row.tasks.total}<span class="tasks"
			>{row.tasks.done}/{row.tasks.total}<span class="visually-hidden">
				{t('board.tasksDone')}</span
			></span
		>{/if}
	{#if row.epic}<span>{t('board.epic', { ref: row.epic })}</span>{/if}
{/snippet}

{#snippet ticketRow(row: BoardTicket)}
	<div class="row">
		<span class="id"
			><ProjectTag code={row.project.code} palette={row.project.palette} /> {row.ref}</span
		>
		{#if renaming === row.id}
			{@render renameForm(row)}
		{:else}
			<a class="title" href={href(row)}>{row.title}</a>
		{/if}
		<p class="meta">
			{#if flow}{@render flowMeta(row)}{:else}{@render lageMeta(row)}{/if}
		</p>
		{@render intents(row)}
		{#if givingBack === row.id}{@render giveBackForm(row)}{/if}
		{#if refusal?.id === row.id}<p class="refusal" role="alert">{refusal.text}</p>{/if}
	</div>
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
			{#key flow}
				<div class="panorama" data-panorama use:sideways>
					{#each groups as group (group.id)}
						<section aria-labelledby="group-{group.id}" data-group={group.id}>
							<h2 id="group-{group.id}">
								{group.title} <span class="count">{group.total}</span>
							</h2>
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
							{#if !group.rows.length}<p class="muted">{t('board.group.empty')}</p>{/if}
							{#if group.total > group.rows.length}
								<p class="muted">
									{t('board.done.more', { shown: group.rows.length, total: group.total })}
								</p>
							{/if}
						</section>
					{/each}
				</div>
			{/key}
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
	h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--type-group);
		font-weight: var(--weight-light);
	}
	.count,
	.muted,
	.meta,
	.hint,
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
	.row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: baseline;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2);
	}
	.id {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--weight-medium) var(--type-meta) var(--font-mono);
		white-space: nowrap;
	}
	.title {
		color: inherit;
		overflow-wrap: anywhere;
		text-decoration: none;
	}
	.title:hover {
		text-decoration: underline;
	}
	.meta,
	.refusal {
		display: flex;
		flex-wrap: wrap;
		grid-column: 1 / -1;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		min-width: 0;
		margin: 0;
	}
	.meta > *,
	.reason {
		min-width: 0;
		overflow-wrap: anywhere;
		white-space: normal;
	}
	.intents {
		display: flex;
		flex-wrap: wrap;
		grid-column: 1 / -1;
		gap: var(--space-2);
	}
	@media (pointer: coarse), (max-width: 375px) {
		.intents :global(button) {
			min-height: 44px;
		}
	}
	.refusal {
		padding: var(--space-1) var(--space-2);
		background: var(--status-failed-tint);
		color: var(--status-failed);
		font-size: var(--type-meta);
	}
	.track {
		display: inline-flex;
		gap: 3px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border: 1px solid currentColor;
		border-radius: 50%;
	}
	.dot.filled {
		background: currentColor;
	}
	.tasks {
		font-variant-numeric: tabular-nums;
	}
	.field-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
	}
	.field-row input {
		flex: 1 1 24ch;
		min-width: 0;
		height: 28px;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-base);
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.field-row.give-back {
		grid-column: 1 / -1;
	}
	.field-row.rename {
		padding: 0;
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
		.board > :not(.panorama) {
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
		.panorama > section {
			flex: 0 0 var(--facet-w);
			overflow-y: auto;
		}
	}
</style>
