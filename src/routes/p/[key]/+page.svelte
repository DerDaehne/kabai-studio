<script lang="ts">
	import { enhance } from '$app/forms';
	import { t } from '$lib/i18n/t';
	import Button from '$lib/ui/Button.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import StepBar from '$lib/ui/StepBar.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let creating = $state(false);

	const focusOnError = (input: HTMLElement) => {
		if (form?.message) input.focus();
	};
</script>

<p class="back"><a href="/projects">{t('projects.back')}</a></p>
<h1><ProjectTag code={data.project.code} palette={data.project.palette} /> {data.project.name}</h1>

<section aria-labelledby="first-ticket">
	<h2 id="first-ticket">{t('projects.ticket.heading')}</h2>
	<p class="intro">{t('projects.ticket.intro')}</p>
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
		<FormField label={t('projects.ticket.title')} error={form?.message}>
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
		<Button type="submit" variant="primary" loading={creating}>{t('projects.ticket.create')}</Button
		>
	</form>
</section>

<section aria-labelledby="steps">
	<h2 id="steps">{t('projects.steps.heading')}</h2>
	<p class="intro">{t('projects.steps.intro', { variant: t(`variant.${data.variant}.name`) })}</p>
	<StepBar steps={data.steps} label={t('projects.steps.heading')} />
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
</style>
