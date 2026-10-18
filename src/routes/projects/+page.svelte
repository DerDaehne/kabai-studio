<script lang="ts">
	import { enhance } from '$app/forms';
	import { t } from '$lib/i18n/t';
	import { openQuestionsLabel } from '$lib/shell/live.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import StepBar from '$lib/ui/StepBar.svelte';
	import { DEFAULT_VARIANT } from '$lib/variant';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let creating = $state(false);

	const errorFor = (field: string) => (form?.field === field ? form.message : undefined);
	const focusOnError = (field: string) => (input: HTMLElement) => {
		if (form?.field === field) input.focus();
	};
	const selectedVariant = $derived(form?.variant ?? DEFAULT_VARIANT);
	const focusedVariant = $derived(
		data.variants.some(({ variant }) => variant === selectedVariant)
			? selectedVariant
			: data.variants[0].variant
	);
	const variantInvalid = $derived(form?.field === 'variant');
</script>

<h1>{t('projects.heading')}</h1>
<p class="intro">{t('projects.intro')}</p>

{#if data.projects.length}
	<ul class="projects">
		{#each data.projects as project (project.id)}
			<li>
				<ProjectTag code={project.code} palette={project.palette} />
				<a class="name" href="/p/{project.code}">{project.name}</a>
				<span class="meta">
					{t(`variant.${project.variant}.name`)} · {openQuestionsLabel(project.openQuestions)}
				</span>
				{#if project.archived}<Badge>{t('projects.archived')}</Badge>{/if}
			</li>
		{/each}
	</ul>
{/if}

<section aria-labelledby="new-project">
	<h2 id="new-project">{t('projects.new')}</h2>
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
		<FormField label={t('projects.name')} error={errorFor('name')}>
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
		<FormField label={t('projects.key')} hint={t('projects.key.hint')} error={errorFor('key')}>
			{#snippet children(attrs)}
				<input
					{...attrs}
					class={[attrs.class, 'key']}
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
		<fieldset aria-describedby={variantInvalid ? 'variant-error' : undefined}>
			<legend>{t('projects.variant.legend')}</legend>
			{#each data.variants as { variant, steps } (variant)}
				<div class="option">
					<label>
						<!-- svelte-ignore a11y_role_supports_aria_props_implicit -->
						<!-- screen readers announce aria-invalid on a radio although the role does not list it -->
						<input
							type="radio"
							name="variant"
							value={variant}
							checked={variant === selectedVariant}
							aria-describedby="variant-{variant}-description{variantInvalid
								? ' variant-error'
								: ''}"
							aria-invalid={variantInvalid ? 'true' : undefined}
							{@attach variant === focusedVariant ? focusOnError('variant') : undefined}
						/>
						{t(`variant.${variant}.name`)}
					</label>
					<div id="variant-{variant}-description" class="description">
						<p>{t(`variant.${variant}.description`)}</p>
						<StepBar {steps} />
					</div>
				</div>
			{/each}
			{#if errorFor('variant')}<p id="variant-error" class="error">{errorFor('variant')}</p>{/if}
		</fieldset>
		<Button type="submit" variant="primary" loading={creating}>{t('projects.create')}</Button>
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
		font-weight: var(--weight-semibold);
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
	form :global(.rk-field),
	input {
		width: 100%;
	}
	.key {
		text-transform: uppercase;
	}
	fieldset {
		display: grid;
		gap: var(--space-2);
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: var(--space-1);
		padding: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}
	.option {
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.option label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
	}
	.option input {
		width: auto;
	}
	.description {
		display: grid;
		gap: var(--space-1);
		margin-top: var(--space-1);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.description p {
		margin: 0;
	}
	.error {
		color: var(--status-failed);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}
</style>
