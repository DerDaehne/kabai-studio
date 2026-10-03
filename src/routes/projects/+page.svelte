<script lang="ts">
	import { enhance } from '$app/forms';
	import { openQuestionsLabel } from '$lib/shell/live.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let creating = $state(false);

	const errorFor = (field: string) => (form?.field === field ? form.message : undefined);
	const focusOnError = (field: string) => (input: HTMLElement) => {
		if (form?.field === field) input.focus();
	};
	const columnsLabel = (count: number) => `${count} ${count === 1 ? 'Spalte' : 'Spalten'}`;
</script>

<h1>Projekte</h1>
<p class="intro">
	Ein Projekt sammelt Tickets in Spalten; jede Spalte gibt den Agents ihre Rolle vor.
</p>

{#if data.projects.length}
	<ul class="projects">
		{#each data.projects as project (project.id)}
			<li>
				<ProjectTag code={project.code} palette={project.palette} />
				<a class="name" href="/p/{project.code}">{project.name}</a>
				<span class="meta">
					{columnsLabel(project.columns)} · {openQuestionsLabel(project.openQuestions)}
				</span>
				{#if project.archived}<Badge>archiviert</Badge>{/if}
			</li>
		{/each}
	</ul>
{/if}

<section aria-labelledby="new-project">
	<h2 id="new-project">Neues Projekt</h2>
	<form
		method="POST"
		action="?/create"
		use:enhance={() => {
			creating = true;
			return async ({ update }) => {
				await update();
				creating = false;
			};
		}}
	>
		<FormField label="Name" error={errorFor('name')}>
			{#snippet children(attrs)}
				<input
					{...attrs}
					name="name"
					required
					autocomplete="off"
					value={form?.name ?? ''}
					{@attach focusOnError('name')}
				/>
			{/snippet}
		</FormField>
		<FormField
			label="Key"
			hint="Großbuchstaben und Ziffern, z. B. WEB. Er steht vor jeder Ticketnummer: WEB-1."
			error={errorFor('key')}
		>
			{#snippet children(attrs)}
				<input
					{...attrs}
					class="key"
					name="key"
					required
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					value={form?.key ?? ''}
					{@attach focusOnError('key')}
				/>
			{/snippet}
		</FormField>
		<p class="template">Die Spalten kommen aus der Vorlage „Software“: Backlog bis Done.</p>
		<Button type="submit" variant="primary" loading={creating}>Projekt anlegen</Button>
	</form>
</section>

<style>
	.intro {
		max-width: 64ch;
		margin-block: var(--space-2) var(--space-4);
		color: var(--text-muted);
	}
	.projects {
		display: grid;
		gap: var(--space-2);
		max-width: 72ch;
		margin-bottom: var(--space-6);
		padding: 0;
		list-style: none;
	}
	.projects li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.name {
		font-weight: 620;
		overflow-wrap: anywhere;
	}
	.meta {
		flex: 1;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	form {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
		max-width: 40ch;
		margin-top: var(--space-2);
	}
	form :global(.field),
	input {
		width: 100%;
	}
	.key {
		text-transform: uppercase;
	}
	.template {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
</style>
