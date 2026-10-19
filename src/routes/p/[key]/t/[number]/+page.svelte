<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/t';
	import type { MessageKey } from '$lib/i18n';
	import { LAGE_TONES, lageText, stepText } from '$lib/lage-text';
	import { openingFacet, ticketHref, type TicketFacet } from '$lib/links';
	import { ticketDependency } from '$lib/live';
	import { splitLead } from '$lib/markdown';
	import RunControl from '$lib/runs/RunControl.svelte';
	import type { RunTab } from '$lib/runs/run-control';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { reloadsTicket } from '$lib/ticket-live';
	import { nextMove } from '$lib/ticket-move';
	import { buildTrace } from '$lib/trace/trace';
	import RunTrace from '$lib/trace/RunTrace.svelte';
	import AgentText from '$lib/ui/AgentText.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Crumb from '$lib/ui/Crumb.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import Icon, { type IconName } from '$lib/ui/Icon.svelte';
	import Pivot, { type Facet } from '$lib/ui/Pivot.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import type { Tone } from '$lib/ui/rekta/tone';
	import StepTrack from '$lib/ui/StepTrack.svelte';
	import { toast } from '$lib/ui/toast.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const ticket = $derived(data.ticket);
	const ticketId = $derived(ticket.id);
	// a string, so a reload that leaves the address as it is does not count as a change of address
	const search = $derived(page.url.search);
	const searchParams = $derived(new URLSearchParams(search));
	const address = $derived(page.params as { key: string; number: string });

	const locale = $derived(page.data.locale);
	const dateTime = $derived(
		new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
	);

	const RELATION_GROUPS = [
		'waits_for',
		'blocks',
		'parent',
		'children',
		'related',
		'duplicate_of',
		'duplicated_by'
	];
	const relationLabel = (group: string) =>
		RELATION_GROUPS.includes(group) ? t(`ticket.relation.${group}` as MessageKey) : group;

	const AUTHOR_ICONS: Record<'user' | 'agent' | 'system', IconName> = {
		user: 'user',
		agent: 'agent',
		system: 'settings'
	};
	const authorLabel = (c: { authorKind: 'user' | 'agent' | 'system'; runId: number | null }) => {
		const author = t(`ticket.author.${c.authorKind}`);
		return c.runId === null ? author : t('ticket.author.run', { author, run: c.runId });
	};

	const RUN_WORDS: Record<RunTab['state'], MessageKey> = {
		queued: 'start.state.queued',
		running: 'start.state.running',
		waiting_approval: 'start.state.waiting',
		paused: 'start.state.paused',
		succeeded: 'start.state.succeeded',
		failed: 'start.state.failed',
		cancelled: 'start.state.cancelled'
	};
	const RUN_TONES: Record<RunTab['state'], Tone> = {
		queued: 'neutral',
		running: 'info',
		waiting_approval: 'warning',
		paused: 'warning',
		succeeded: 'success',
		failed: 'error',
		cancelled: 'neutral'
	};
	const runWord = (run: RunTab) => t(RUN_WORDS[run.halted ? 'paused' : run.state]);

	const openTasks = $derived(ticket.tasks.filter((task) => !task.done).length);
	const stepCount = $derived(
		data.trace
			? buildTrace(data.trace.events).items.filter((item) => item.kind === 'step').length
			: 0
	);

	const facets = $derived<Facet[]>([
		...(ticket.openQuestion
			? [{ id: 'frage', label: t('ticket.facet.question'), count: 1, width: '560px' }]
			: []),
		{ id: 'spur', label: t('ticket.facet.trace'), count: stepCount, width: '680px' },
		{ id: 'akte', label: t('ticket.facet.file'), count: openTasks, width: '520px' },
		{ id: 'runs', label: t('ticket.facet.runs'), count: data.runs.length, width: '460px' }
	]);

	const opening = () =>
		openingFacet(searchParams, {
			hasQuestion: !!ticket.openQuestion,
			hasRuns: data.runs.length > 0
		});

	let active = $state<string>(untrack(opening));

	// Another ticket, run or facet in the address (a link, back, forward) brings its own facet in front.
	$effect.pre(() => {
		void [ticketId, search];
		active = untrack(opening);
	});
	// An answered question takes its facet away; the one that took its place moves to the front.
	$effect.pre(() => {
		if (active === 'frage' && !ticket.openQuestion) active = untrack(opening);
	});

	/** Puts the facet in the address without a history entry: back leaves the Run-Akte, not the facet. */
	function rememberFacet(id: string) {
		const run = Number(searchParams.get('run')) || undefined;
		void goto(ticketHref(address.key, address.number, { run, facet: id as TicketFacet }), {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	}

	let editOpen = $state(false);
	let addTaskInput: HTMLInputElement | undefined = $state();
	let commentInput: HTMLTextAreaElement | undefined = $state();
	let deleteOpen = $state(false);
	let taskDialog = $state<{ taskId: number; title: string; mode: 'rename' | 'delete' } | null>(
		null
	);
	let moveForms: Record<number, HTMLFormElement> = {};

	/** Escape leaves a focused field so the shortcuts (o, a, i, >/<, h/l) work again instead of staying dead. */
	function blurOnEscape(event: KeyboardEvent) {
		if (event.key === 'Escape') (event.currentTarget as HTMLElement).blur();
	}

	/** The fields live in the file; where only one facet shows, it comes to the front first. */
	async function focusInFile(field: () => HTMLElement | undefined) {
		if (active !== 'akte') {
			active = 'akte';
			rememberFacet('akte');
			await tick();
		}
		field()?.focus();
	}

	/**
	 * `>`/`<`: the next (or previous) normal/done column by board position; never wraps past either end and
	 * never lands on a human column. A blocked target shows its own reason instead of being skipped.
	 */
	function stepColumn(forward: boolean) {
		const target = nextMove(ticket.moves, ticket.column.position, forward);
		if (!target) return void toast(t(forward ? 'ticket.moves.noNext' : 'ticket.moves.noPrevious'));
		if (target.blockers.length) {
			const [blocker] = target.blockers;
			return void toast(`${blocker.message} ${blocker.hint}`);
		}
		moveForms[target.columnId]?.requestSubmit();
	}

	function openTaskDialog(task: { id: number; title: string }, mode: 'rename' | 'delete') {
		taskDialog = { taskId: task.id, title: task.title, mode };
	}

	/** A refused toggle puts the box back; an accepted one is redrawn from the reloaded task. */
	const toggleTask: SubmitFunction =
		({ formElement }) =>
		async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') return;
			const wasDone = formElement.getAttribute('action') === '?/reopenTask';
			formElement.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = wasDone;
		};

	$effect(() =>
		bindKeys({
			editText: () => (editOpen = true),
			add: () => void focusInFile(() => addTaskInput),
			comment: () => void focusInFile(() => commentInput),
			shiftColumn: (_count, key) => stepColumn(key === '>')
		})
	);

	const reloadTicket = () => void invalidateLive(ticketDependency(ticket.id));

	// Agent changes (comment, task, column, run) reach this tab's one live connection; a matching event reloads the ticket.
	$effect(() =>
		onLiveEvent((event) => {
			if (reloadsTicket(event, ticket.id)) reloadTicket();
		})
	);
</script>

{#snippet formError(action: string)}
	{#if form?.action === action}<p role="alert">{form.message} {form.hint}</p>{/if}
{/snippet}

{#snippet taskRow(task: (typeof ticket.tasks)[number])}
	<form
		method="POST"
		action={task.done ? '?/reopenTask' : '?/completeTask'}
		use:enhance={toggleTask}
	>
		<input type="hidden" name="taskId" value={task.id} />
		<label class="rk-switch">
			<input
				type="checkbox"
				checked={task.done}
				onchange={(event) => event.currentTarget.form?.requestSubmit()}
			/>
			{task.title}
		</label>
	</form>
	<span class="rk-actions">
		<Button size="sm" variant="ghost" onclick={() => openTaskDialog(task, 'rename')}
			>{t('ticket.task.rename')}</Button
		>
		<Button size="sm" variant="ghost" onclick={() => openTaskDialog(task, 'delete')}
			>{t('ticket.task.delete')}</Button
		>
	</span>
{/snippet}

{#snippet questionFacet()}
	{#if ticket.openQuestion}
		{@const question = splitLead(ticket.openQuestion.question)}
		<div class="question">
			<div class="question-lead" role="status">
				<Tag tone="warning">{t('ticket.question.lead')}</Tag>
				<p>{question.lead}</p>
			</div>
			{#if question.rest}<AgentText text={question.rest} />{/if}
			<a class="rk-btn" href="/takt">{t('ticket.question.toTakt')} <Kbd key="g" /><Kbd key="t" /></a
			>
		</div>
	{/if}
{/snippet}

{#snippet traceFacet()}
	{#if data.trace}
		{#key data.trace.id}<RunTrace trace={data.trace} reload={reloadTicket} />{/key}
	{:else}
		<EmptyState title={t('ticket.trace.empty.title')}>{t('ticket.trace.empty.text')}</EmptyState>
	{/if}
{/snippet}

{#snippet fileFacet()}
	<div class="description">
		{#if ticket.description.trim()}<AgentText text={ticket.description} breaks={false} />{:else}<p
				class="muted"
			>
				{t('ticket.description.empty')}
			</p>{/if}
	</div>

	<h3>{t('ticket.tasks.heading')}</h3>
	<ul class="rk-rows tasks">
		{#each ticket.tasks as task (task.id)}
			<li>{@render taskRow(task)}</li>
		{:else}
			<li class="muted">{t('ticket.tasks.empty')}</li>
		{/each}
	</ul>
	<form method="POST" action="?/addTask" use:enhance>
		<FormField label={t('ticket.task.new')}>
			{#snippet children(a)}<input
					{...a}
					name="title"
					bind:this={addTaskInput}
					onkeydown={blurOnEscape}
					required
				/>{/snippet}
		</FormField>
		<Button type="submit" size="sm">{t('ticket.task.create')}</Button>
	</form>
	{@render formError('addTask')}

	<h3>{t('ticket.comments.heading')}</h3>
	<ul class="rk-rows comments">
		{#each ticket.comments as comment (comment.id)}
			<li>
				<span class="author"
					><Icon name={AUTHOR_ICONS[comment.authorKind]} size={14} />{authorLabel(comment)}</span
				>
				<AgentText text={comment.body} />
			</li>
		{:else}
			<li class="muted">{t('ticket.comments.empty')}</li>
		{/each}
	</ul>
	<form method="POST" action="?/addComment" use:enhance>
		<FormField label={t('ticket.comment.label')}>
			{#snippet children(a)}<textarea
					{...a}
					name="body"
					rows="2"
					bind:this={commentInput}
					onkeydown={blurOnEscape}
					required></textarea>{/snippet}
		</FormField>
		<Button type="submit" size="sm">{t('ticket.comment.write')}</Button>
	</form>
	{@render formError('addComment')}

	<h3>{t('ticket.relations.heading')}</h3>
	{#each Object.entries(ticket.relations) as [group, items] (group)}
		<h4 class="relation-group">{relationLabel(group)}</h4>
		<ul class="rk-rows relations">
			{#each items as rel (rel.ref)}
				<li>
					<span class="relation"
						><b>{rel.ref}</b>{#if rel.title}<span>{rel.title}</span>{/if}</span
					>
					<span class="rk-actions">
						{#if rel.column}<Tag>{rel.column}</Tag>{/if}
						{#if rel.blocking}<Tag tone="warning">{t('ticket.relation.blocking')}</Tag>{/if}
						{#if rel.other_project}<Tag>{t('ticket.relation.otherProject')}</Tag>{/if}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">{t('ticket.relations.empty')}</p>
	{/each}

	<h3>{t('ticket.moves.heading')}</h3>
	<p class="muted">{t('ticket.moves.intro')}</p>
	<ul class="moves">
		{#each ticket.moves as move (move.columnId)}
			<li>
				{#if move.blockers.length === 0}
					<form method="POST" action="?/move" use:enhance bind:this={moveForms[move.columnId]}>
						<input type="hidden" name="columnId" value={move.columnId} />
						<Button type="submit" size="sm">{move.name}</Button>
					</form>
				{:else}
					<p class="blocked">
						<strong>{move.name}:</strong>
						{#each move.blockers as blocker (blocker.code)}{blocker.message} {blocker.hint}{/each}
					</p>
				{/if}
			</li>
		{/each}
	</ul>
	{@render formError('move')}

	<Button variant="danger" size="sm" onclick={() => (deleteOpen = true)}
		>{t('ticket.delete')}</Button
	>
{/snippet}

{#snippet runsFacet()}
	{#if data.runs.length}
		<ul class="rk-rows runs" aria-label={t('ticket.runs.list')}>
			{#each data.runs as run (run.id)}
				<li>
					<a href={ticketHref(address.key, address.number, { run: run.id, facet: 'spur' })}
						><b>{t('ticket.runs.open', { id: run.id })}</b></a
					>
					<span class="rk-actions">
						<Tag tone={RUN_TONES[run.halted ? 'paused' : run.state]}>{runWord(run)}</Tag>
						{#if run.profile}<span class="muted">{run.profile}</span>{/if}
						{#if run.startedAt}<span class="muted">{dateTime.format(new Date(run.startedAt))}</span
							>{/if}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">{t('ticket.runs.empty')}</p>
	{/if}
{/snippet}

<svelte:head
	><title>{t('ticket.title', { ref: ticket.ref, title: ticket.title })}</title></svelte:head
>

<Crumb href="/board" label={t('board.heading')} />
<header class="ticket-head">
	<p class="rk-kicker">
		<ProjectTag code={ticket.project.code} palette={ticket.project.palette} />
		{ticket.ref}
	</p>
	<h1 class="rk-title">{ticket.title}</h1>
	<p class="rk-facts" data-testid="facts">
		{#if ticket.lage}
			<Tag tone={ticket.lage.reason.kind === 'failure' ? 'error' : LAGE_TONES[ticket.lage.lage]}
				><span class="reason">{lageText(ticket.lage)}</span></Tag
			>
			<StepTrack progress={ticket.lage.progress} />
			<span>{stepText({ ...ticket.lage, phase: ticket.column.phase })}</span>
		{/if}
		{#if data.runs[0]?.profile}<span>{t('ticket.profile', { profile: data.runs[0].profile })}</span
			>{/if}
		{#if data.flow}<span>{t('ticket.column', { name: ticket.column.name })}</span>{/if}
	</p>
	<div class="rk-actions">
		<Button size="sm" onclick={() => (editOpen = true)}>{t('ticket.edit')} <Kbd key="i" /></Button>
	</div>
</header>
<RunControl runs={data.runs} start={data.start} selected={data.trace?.id} {form} />

<Pivot {facets} bind:active onchange={rememberFacet} label={t('ticket.facets')}>
	{#snippet panel(facet)}
		{#if facet.id === 'frage'}
			{@render questionFacet()}
		{:else if facet.id === 'spur'}
			{@render traceFacet()}
		{:else if facet.id === 'akte'}
			{@render fileFacet()}
		{:else}
			{@render runsFacet()}
		{/if}
	{/snippet}
</Pivot>

<Dialog bind:open={editOpen} title={t('ticket.editDialog.title')}>
	<form
		method="POST"
		action="?/update"
		use:enhance={() =>
			async ({ result, update }) => {
				await update();
				if (result.type === 'success') editOpen = false;
			}}
	>
		<FormField label={t('ticket.editDialog.titleField')}>
			<!-- svelte-ignore a11y_autofocus -->
			{#snippet children(a)}<input
					{...a}
					name="title"
					value={ticket.title}
					required
					autofocus
				/>{/snippet}
		</FormField>
		<FormField label={t('ticket.editDialog.description')} hint={t('ticket.editDialog.hint')}>
			{#snippet children(a)}<textarea {...a} name="description" rows="8"
					>{ticket.description}</textarea
				>{/snippet}
		</FormField>
		{@render formError('update')}
		<Button type="button" variant="ghost" onclick={() => (editOpen = false)}
			>{t('ticket.editDialog.cancel')}</Button
		>
		<Button type="submit" variant="primary">{t('ticket.save')}</Button>
	</form>
</Dialog>

<Dialog
	bind:open={() => taskDialog !== null, (open) => !open && (taskDialog = null)}
	title={taskDialog?.mode === 'rename'
		? t('ticket.taskDialog.rename')
		: t('ticket.taskDialog.delete')}
>
	{#if taskDialog}
		<form
			method="POST"
			action={taskDialog.mode === 'rename' ? '?/renameTask' : '?/deleteTask'}
			use:enhance={() =>
				async ({ result, update }) => {
					await update();
					if (result.type === 'success') taskDialog = null;
				}}
		>
			<input type="hidden" name="taskId" value={taskDialog.taskId} />
			{#if taskDialog.mode === 'rename'}
				<FormField label={t('ticket.editDialog.titleField')}>
					{#snippet children(a)}<input
							{...a}
							name="title"
							value={taskDialog?.title}
							required
						/>{/snippet}
				</FormField>
			{/if}
			<FormField label={t('ticket.taskDialog.reason')} hint={t('ticket.taskDialog.reasonHint')}>
				{#snippet children(a)}<input {...a} name="reason" required />{/snippet}
			</FormField>
			{@render formError('taskDialog')}
			<Button type="button" variant="ghost" onclick={() => (taskDialog = null)}
				>{t('ticket.cancel')}</Button
			>
			<Button type="submit" variant={taskDialog.mode === 'delete' ? 'danger' : 'primary'}>
				{taskDialog.mode === 'delete' ? t('ticket.task.delete') : t('ticket.save')}
			</Button>
		</form>
	{/if}
</Dialog>

<Dialog bind:open={deleteOpen} title={t('ticket.delete')}>
	<p>{t('ticket.delete.body', { ref: ticket.ref, title: ticket.title })}</p>
	<form method="POST" action="?/delete" use:enhance>
		<Button type="button" variant="ghost" onclick={() => (deleteOpen = false)}
			>{t('ticket.cancel')}</Button
		>
		<Button type="submit" variant="danger">{t('ticket.delete.confirm')}</Button>
	</form>
</Dialog>

<style>
	.ticket-head {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.ticket-head :is(p, h1) {
		margin: 0;
	}
	.rk-kicker {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-family: var(--font-mono);
	}
	.rk-title {
		max-width: 60ch;
		overflow-wrap: anywhere;
	}
	.rk-facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
	}
	.rk-facts .reason {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.question {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		background: var(--status-waiting-tint);
	}
	.question-lead {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	.question-lead p {
		margin: 0;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.rk-rows {
		margin: 0 0 var(--space-3);
	}
	.tasks > li,
	.moves > li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.moves {
		display: grid;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
		padding: 0;
		list-style: none;
	}
	.comments > li {
		display: grid;
		justify-content: stretch;
		gap: var(--space-1);
	}
	.relation {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
	}
	h3 {
		margin: var(--space-4) 0 var(--space-2);
	}
	.relation-group {
		margin: var(--space-3) 0 var(--space-1);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.author {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-muted);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}
	.blocked {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--text-muted);
	}
</style>
