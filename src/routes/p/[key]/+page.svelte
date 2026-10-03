<script lang="ts">
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let creating = $state(false);

	const focusOnError = (input: HTMLElement) => {
		if (form?.message) input.focus();
	};
</script>

<p class="back"><a href="/projects">Alle Projekte</a></p>
<h1><ProjectTag code={data.project.code} palette={data.project.palette} /> {data.project.name}</h1>

<section aria-labelledby="first-ticket">
	<h2 id="first-ticket">Ticket anlegen</h2>
	<p class="intro">Ein Ticket startet im Backlog; in seiner Run-Akte gibst du es einem Agent.</p>
	<form
		method="POST"
		action="?/createTicket"
		use:enhance={() => {
			creating = true;
			return async ({ update }) => {
				await update();
				creating = false;
			};
		}}
	>
		<FormField label="Titel" error={form?.message}>
			{#snippet children(attrs)}
				<input
					{...attrs}
					name="title"
					required
					autocomplete="off"
					value={form?.title ?? ''}
					{@attach focusOnError}
				/>
			{/snippet}
		</FormField>
		<Button type="submit" variant="primary" loading={creating}>Ticket anlegen</Button>
	</form>
</section>

<section aria-labelledby="columns">
	<h2 id="columns">Spalten</h2>
	<ol class="columns">
		{#each data.columns as column (column.name)}
			<li>
				<span class="name">{column.name}</span>
				{#if column.role}<span class="role">{column.role}</span>{/if}
			</li>
		{/each}
	</ol>
</section>

<style>
	.back {
		font-size: var(--text-sm);
	}
	h1 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-block: var(--space-1) var(--space-4);
		overflow-wrap: anywhere;
	}
	section {
		max-width: 72ch;
		margin-bottom: var(--space-6);
	}
	.intro {
		margin-block: var(--space-1) var(--space-2);
		color: var(--text-muted);
	}
	form {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
	}
	form :global(.field) {
		flex: 1 1 24ch;
	}
	.columns {
		display: grid;
		gap: var(--space-1);
		margin-top: var(--space-2);
		padding: 0;
		list-style: none;
	}
	.columns li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.name {
		flex: 0 0 18ch;
		font-weight: 620;
	}
	/* the role prompt in short: two lines, the full text stays in the DOM for screen readers */
	.role {
		flex: 1 1 30ch;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
</style>
