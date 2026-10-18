<script lang="ts">
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n/t';
	import type { MessageKey } from '$lib/i18n';
	import { LAGE_TONES, lageText, reasonText, stepText } from '$lib/lage-text';
	import { ticketHref } from '$lib/links';
	import Button from '$lib/ui/Button.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import StepTrack from '$lib/ui/StepTrack.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import { escapeTo, focusField } from './field';
	import type { RowEditor } from './row-flows.svelte';
	import { canAccept, canGiveBack, canStart, type BoardTicket } from './list';

	let { row, flow, editor }: { row: BoardTicket; flow: boolean; editor: RowEditor } = $props();

	const renaming = $derived(editor.renaming === row.id);
	const givingBack = $derived(editor.givingBack === row.id);
	const refusal = $derived(editor.refusal?.id === row.id ? editor.refusal.text : undefined);

	const RUN_WORDS: Record<NonNullable<BoardTicket['run']>['state'], MessageKey> = {
		queued: 'start.state.queued',
		running: 'start.state.running',
		waiting_approval: 'start.state.waiting',
		paused: 'start.state.paused',
		succeeded: 'start.state.succeeded',
		failed: 'start.state.failed',
		cancelled: 'start.state.cancelled'
	};

	const href = $derived(ticketHref(row.project.code, row.number));
</script>

{#snippet renameForm()}
	<form
		class="field-row rename"
		onsubmit={(event) => {
			event.preventDefault();
			editor.rename(row);
		}}
	>
		<input
			aria-label={t('board.rename.label', { ref: row.ref })}
			autocomplete="off"
			bind:value={editor.renameTitle}
			onkeydown={escapeTo(() => editor.cancelRenaming(row))}
			{@attach focusField}
		/>
		<Button type="submit" size="sm">{t('board.rename.save')}</Button>
	</form>
{/snippet}

{#snippet giveBackForm()}
	<form
		class="field-row give-back"
		onsubmit={(event) => {
			event.preventDefault();
			void editor.giveBack(row);
		}}
	>
		<input
			aria-label={t('board.giveBack.label', { ref: row.ref })}
			placeholder={t('board.giveBack.placeholder')}
			autocomplete="off"
			bind:value={editor.giveBackComment}
			onkeydown={escapeTo(() => editor.cancelGivingBack(row))}
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

{#snippet intents()}
	<span class="intents" role="group" aria-label={t('board.intents.label', { ref: row.ref })}>
		{#if row.reason.kind === 'question'}
			<Button size="sm" onclick={() => void goto(href)}
				>{t('board.intent.answer')} <Kbd key="Enter" /></Button
			>
		{:else if canStart(row)}
			<Button size="sm" onclick={() => void editor.start(row)}
				>{t('board.intent.start')} <Kbd key="s" /></Button
			>
		{/if}
		{#if canAccept(row)}
			<Button size="sm" onclick={() => void editor.accept(row)}
				>{t('board.intent.accept')} <Kbd key="a" /></Button
			>
		{/if}
		{#if canGiveBack(row)}
			<Button size="sm" onclick={() => editor.startGivingBack(row)}
				>{t('board.intent.giveBack')} <Kbd key="r" /></Button
			>
		{/if}
	</span>
{/snippet}

{#snippet lageMeta()}
	<StepTrack progress={row.progress} />
	<span class="step">{stepText({ lage: row.lage, phase: row.column.phase, step: row.step })}</span>
	{#if reasonText(row)}
		<Tag tone={row.reason.kind === 'failure' ? 'error' : LAGE_TONES[row.lage]}
			><span class="reason">{reasonText(row)}</span></Tag
		>
	{/if}
{/snippet}

{#snippet flowMeta()}
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

<div class="row">
	<span class="id"
		><ProjectTag code={row.project.code} palette={row.project.palette} /> {row.ref}</span
	>
	{#if renaming}
		{@render renameForm()}
	{:else}
		<a class="title" {href}>{row.title}</a>
	{/if}
	<p class="meta">
		{#if flow}{@render flowMeta()}{:else}{@render lageMeta()}{/if}
	</p>
	{@render intents()}
	{#if givingBack}{@render giveBackForm()}{/if}
	{#if refusal}<p class="refusal" role="alert">{refusal}</p>{/if}
</div>

<style>
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
	.hint,
	.meta {
		color: var(--text-muted);
		font-size: var(--type-meta);
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
</style>
