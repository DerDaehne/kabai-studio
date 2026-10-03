<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { renderDescription } from '$lib/markdown';
	import RunControl from '$lib/runs/RunControl.svelte';
	import { onLiveEvent } from '$lib/shell/live.svelte';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { reloadsTicket } from '$lib/ticket-live';
	import { nextMove } from '$lib/ticket-move';
	import RunTrace from '$lib/trace/RunTrace.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import Icon, { type IconName } from '$lib/ui/Icon.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import { toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const ticket = $derived(data.ticket);

	const RELATION_LABELS: Record<string, string> = {
		waits_for: 'Wartet auf',
		blocks: 'Blockiert',
		parent: 'Eltern-Ticket',
		children: 'Kinder',
		related: 'Verwandt',
		duplicate_of: 'Duplikat von',
		duplicated_by: 'Dupliziert durch'
	};

	let area = $state<'spur' | 'auftrag'>('auftrag');
	let spurArea: HTMLElement | undefined = $state();
	let auftragArea: HTMLElement | undefined = $state();

	async function focusArea(name: 'spur' | 'auftrag') {
		area = name;
		await tick();
		(name === 'spur' ? spurArea : auftragArea)?.focus();
	}

	const AUTHOR_LABELS: Record<'user' | 'agent' | 'system', string> = {
		user: 'Mensch',
		agent: 'Agent',
		system: 'System'
	};
	const AUTHOR_ICONS: Record<'user' | 'agent' | 'system', IconName> = {
		user: 'user',
		agent: 'agent',
		system: 'settings'
	};
	const authorLabel = (c: { authorKind: 'user' | 'agent' | 'system'; runId: number | null }) =>
		AUTHOR_LABELS[c.authorKind] + (c.runId !== null ? ` · Run ${c.runId}` : '');

	/** Escape leaves a focused field so the shortcuts (o, a, i, >/<, h/l) work again instead of staying dead. */
	function blurOnEscape(event: KeyboardEvent) {
		if (event.key === 'Escape') (event.currentTarget as HTMLElement).blur();
	}

	let editOpen = $state(false);
	let addTaskInput: HTMLInputElement | undefined = $state();
	let commentInput: HTMLTextAreaElement | undefined = $state();
	let deleteOpen = $state(false);
	let taskDialog = $state<{ taskId: number; title: string; mode: 'rename' | 'delete' } | null>(
		null
	);
	let moveForms: Record<number, HTMLFormElement> = {};

	/**
	 * `>`/`<`: the next (or previous) normal/done column by board position; never wraps past either end and
	 * never lands on a human column. A blocked target shows its own reason instead of being skipped.
	 */
	function stepColumn(forward: boolean) {
		const target = nextMove(ticket.moves, ticket.column.position, forward);
		if (!target) return void toast(`Keine ${forward ? 'nächste' : 'vorige'} Spalte erreichbar.`);
		if (target.blockers.length) {
			const [blocker] = target.blockers;
			return void toast(`${blocker.message} ${blocker.hint}`);
		}
		moveForms[target.columnId]?.requestSubmit();
	}

	function openTaskDialog(task: { id: number; title: string }, mode: 'rename' | 'delete') {
		taskDialog = { taskId: task.id, title: task.title, mode };
	}

	$effect(() =>
		bindKeys({
			side: (_count, key) => focusArea(key === 'h' ? 'spur' : 'auftrag'),
			editText: () => (editOpen = true),
			add: () => addTaskInput?.focus(),
			comment: () => commentInput?.focus(),
			shiftColumn: (_count, key) => stepColumn(key === '>')
		})
	);

	const reloadTicket = () => void invalidate(`studio:ticket:${ticket.id}`);

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

<svelte:head><title>{ticket.ref} {ticket.title} – kabai studio</title></svelte:head>

<p class="crumbs">
	<a href="/">Stellwerk</a> /
	<ProjectTag code={ticket.project.code} palette={ticket.project.palette} />
	{ticket.project.name} / {ticket.ref}
</p>
<header class="ticket-head">
	<h1>{ticket.title}</h1>
	<Badge>{ticket.column.name}</Badge>
	<Button size="sm" onclick={() => (editOpen = true)}>Bearbeiten (i)</Button>
</header>
<RunControl runs={data.runs} start={data.start} selected={data.trace?.id} {form} />

{#if ticket.openQuestion}
	<div class="question" role="status">
		<Badge tone="waiting">Offene Frage</Badge>
		<p>{ticket.openQuestion.question}</p>
		<a class="btn btn-sm" href="/takt">In Takt beantworten (gt)</a>
	</div>
{/if}

<div class="areas">
	<section
		class="auftrag"
		aria-labelledby="h-auftrag"
		tabindex="-1"
		bind:this={auftragArea}
		class:focused={area === 'auftrag'}
	>
		<h2 id="h-auftrag">Auftrag</h2>

		<div class="description">
			{#if ticket.description.trim()}{@html renderDescription(ticket.description)}{:else}<p
					class="muted"
				>
					Keine Beschreibung.
				</p>{/if}
		</div>

		<h3>Tasks</h3>
		<ul class="tasks">
			{#each ticket.tasks as task (task.id)}
				<li>
					<form method="POST" action={task.done ? '?/reopenTask' : '?/completeTask'} use:enhance>
						<input type="hidden" name="taskId" value={task.id} />
						<button type="submit" class="task-toggle" aria-pressed={task.done}>
							{task.done ? '[x]' : '[ ]'}
							{task.title}
						</button>
					</form>
					<Button size="sm" variant="ghost" onclick={() => openTaskDialog(task, 'rename')}
						>Umbenennen</Button
					>
					<Button size="sm" variant="ghost" onclick={() => openTaskDialog(task, 'delete')}
						>Löschen</Button
					>
				</li>
			{:else}
				<li class="muted">Noch keine Tasks.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addTask" use:enhance>
			<FormField label="Neuer Task">
				{#snippet children(a)}<input
						{...a}
						name="title"
						bind:this={addTaskInput}
						onkeydown={blurOnEscape}
						required
					/>{/snippet}
			</FormField>
			<Button type="submit" size="sm">Anlegen (o)</Button>
		</form>
		{@render formError('addTask')}

		<h3>Kommentare</h3>
		<ul class="comments">
			{#each ticket.comments as comment (comment.id)}
				<li>
					<span class="author"
						><Icon name={AUTHOR_ICONS[comment.authorKind]} size={14} />{authorLabel(comment)}</span
					>
					<p class="comment-body">{comment.body}</p>
				</li>
			{:else}
				<li class="muted">Noch keine Kommentare.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addComment" use:enhance>
			<FormField label="Kommentar">
				{#snippet children(a)}<textarea
						{...a}
						name="body"
						rows="2"
						bind:this={commentInput}
						onkeydown={blurOnEscape}
						required></textarea>{/snippet}
			</FormField>
			<Button type="submit" size="sm">Schreiben (a)</Button>
		</form>
		{@render formError('addComment')}

		<h3>Relationen</h3>
		{#each Object.entries(ticket.relations) as [key, items] (key)}
			<p class="relation-group"><strong>{RELATION_LABELS[key] ?? key}:</strong></p>
			<ul class="relations">
				{#each items as rel (rel.ref)}
					<li>
						{rel.ref}
						{#if rel.title}— {rel.title}{/if}
						{#if rel.column}<Badge>{rel.column}</Badge>{/if}
						{#if rel.blocking}<Badge tone="waiting">blockiert noch</Badge>{/if}
						{#if rel.other_project}<Badge>anderes Projekt</Badge>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Keine Relationen.</p>
		{/each}

		<h3>Spalte</h3>
		<p class="muted">
			Erlaubte Ziele; <kbd>&gt;</kbd>/<kbd>&lt;</kbd> springt zum nächsten/vorigen.
		</p>
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

		<Button variant="danger" size="sm" onclick={() => (deleteOpen = true)}>Ticket löschen</Button>
	</section>

	<section
		class="spur"
		aria-labelledby="h-spur"
		tabindex="-1"
		bind:this={spurArea}
		class:focused={area === 'spur'}
	>
		<h2 id="h-spur">Spur</h2>
		{#if data.trace}
			{#key data.trace.id}<RunTrace trace={data.trace} reload={reloadTicket} />{/key}
		{:else}
			<EmptyState title="Noch kein Run"
				>Hier erscheinen die Schritte, sobald ein Agent an diesem Ticket arbeitet.</EmptyState
			>
		{/if}
	</section>
</div>

<Dialog bind:open={editOpen} title="Titel und Beschreibung bearbeiten">
	<form
		method="POST"
		action="?/update"
		use:enhance={() =>
			async ({ result, update }) => {
				await update();
				if (result.type === 'success') editOpen = false;
			}}
	>
		<FormField label="Titel">
			<!-- svelte-ignore a11y_autofocus -->
			{#snippet children(a)}<input
					{...a}
					name="title"
					value={ticket.title}
					required
					autofocus
				/>{/snippet}
		</FormField>
		<FormField label="Beschreibung" hint="Markdown wird beim Speichern sicher gerendert.">
			{#snippet children(a)}<textarea {...a} name="description" rows="8"
					>{ticket.description}</textarea
				>{/snippet}
		</FormField>
		{@render formError('update')}
		<Button type="button" variant="ghost" onclick={() => (editOpen = false)}>Abbrechen (esc)</Button
		>
		<Button type="submit" variant="primary">Speichern</Button>
	</form>
</Dialog>

<Dialog
	bind:open={() => taskDialog !== null, (open) => !open && (taskDialog = null)}
	title={taskDialog?.mode === 'rename' ? 'Task umbenennen' : 'Task löschen'}
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
				<FormField label="Titel">
					{#snippet children(a)}<input
							{...a}
							name="title"
							value={taskDialog?.title}
							required
						/>{/snippet}
				</FormField>
			{/if}
			<FormField label="Grund" hint="Erscheint als System-Kommentar am Ticket.">
				{#snippet children(a)}<input {...a} name="reason" required />{/snippet}
			</FormField>
			{@render formError('taskDialog')}
			<Button type="button" variant="ghost" onclick={() => (taskDialog = null)}>Abbrechen</Button>
			<Button type="submit" variant={taskDialog.mode === 'delete' ? 'danger' : 'primary'}>
				{taskDialog.mode === 'delete' ? 'Löschen' : 'Speichern'}
			</Button>
		</form>
	{/if}
</Dialog>

<Dialog bind:open={deleteOpen} title="Ticket löschen">
	<p>
		{ticket.ref} „{ticket.title}“ unwiderruflich löschen? Das lässt sich nicht rückgängig machen.
	</p>
	<form method="POST" action="?/delete" use:enhance>
		<Button type="button" variant="ghost" onclick={() => (deleteOpen = false)}>Abbrechen</Button>
		<Button type="submit" variant="danger">Endgültig löschen</Button>
	</form>
</Dialog>

<style>
	.crumbs {
		margin: 0 0 var(--space-2);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.crumbs a {
		color: inherit;
	}
	.ticket-head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.ticket-head h1 {
		margin: 0;
	}
	.question {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		margin-top: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		background: var(--status-waiting-tint);
	}
	.question p {
		flex: 1;
		margin: 0;
	}
	.areas {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-4);
		margin-top: var(--space-4);
	}
	.areas section {
		border-radius: var(--radius-lg);
		outline: none;
	}
	.areas section.focused {
		box-shadow: 0 0 0 2px var(--focus);
	}
	.spur {
		padding: var(--space-3);
		background: var(--surface-sunken);
	}
	.tasks,
	.comments,
	.relations,
	.moves {
		display: grid;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
		padding: 0;
		list-style: none;
	}
	.tasks li,
	.moves li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.task-toggle {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
	}
	.author {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-muted);
		font-size: var(--text-sm);
		font-weight: 560;
	}
	.comment-body {
		margin: var(--space-1) 0 0;
		white-space: pre-wrap;
	}
	.blocked {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--text-muted);
	}

	@media (min-width: 720px) {
		.areas {
			grid-template-columns: minmax(280px, 1fr) minmax(320px, 1fr);
			grid-template-areas: 'spur auftrag';
		}
		.spur {
			grid-area: spur;
		}
		.auftrag {
			grid-area: auftrag;
		}
	}
</style>
