<script lang="ts">
	import { t } from '$lib/i18n/t';
	import Button from '$lib/ui/Button.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import type { ProjectRef } from '$lib/shell/shell.svelte';
	import { escapeTo, focusField } from './field';

	let {
		project,
		title = $bindable(),
		error,
		onsubmit,
		oncancel
	}: {
		project: ProjectRef;
		title: string;
		/** Why the ticket was not created, with its way out. */
		error?: string;
		onsubmit: () => void;
		oncancel: () => void;
	} = $props();
</script>

<form
	class="field-row"
	onsubmit={(event) => {
		event.preventDefault();
		onsubmit();
	}}
>
	<ProjectTag code={project.code} palette={project.palette} />
	<input
		aria-label={t('board.draft.label', { project: project.name })}
		placeholder={t('board.draft.placeholder')}
		autocomplete="off"
		bind:value={title}
		aria-invalid={error ? 'true' : undefined}
		onkeydown={escapeTo(oncancel)}
		{@attach focusField}
	/>
	<Button type="submit" size="sm">{t('board.draft.create')}</Button>
	<span class="hint"
		><Kbd key="Enter" />
		{t('board.draft.hintCreate')} · <Kbd key="Escape" />
		{t('board.draft.hintDiscard')}</span
	>
	{#if error}<p class="refusal" role="alert">{error}</p>{/if}
</form>

<style>
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
	.refusal {
		flex-basis: 100%;
		margin: 0;
		padding: var(--space-1) var(--space-2);
		background: var(--status-failed-tint);
		color: var(--status-failed);
		font-size: var(--type-meta);
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
</style>
