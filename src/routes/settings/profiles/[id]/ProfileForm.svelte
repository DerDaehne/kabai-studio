<!--
	Editor for one builtin agent profile. The fields join the profile form through their `form` attribute, so the
	secret field with its own forms can sit right below the key reference without nesting forms.
-->
<script lang="ts">
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { MODEL_ROLES } from '$lib/agents/model-catalog';
	import {
		BASE_URL_EXAMPLE,
		catalogDefaults,
		cloudModelOptions,
		DEFAULT_PORTS,
		defaultPool,
		extraPromptWarning,
		POOL_LABELS,
		PROVIDERS,
		pricingNotice,
		thinkingBudgetWarning,
		withCatalogDefaults
	} from '$lib/agents/profile-defaults';
	import SecretField from '$lib/components/SecretField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import FormField, { type FieldAttrs } from '$lib/ui/FormField.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const KEY_REF_HINT =
		'Verweis secret:<name> auf ein gespeichertes Secret oder ${NAME} für eine Umgebungsvariable, nie der Key selbst. Leer: ohne Key.';

	const formId = $props.id();
	// The form edits its own copy; the page starts a fresh form for each profile.
	const initial = untrack(() => data.values);
	let values = $state({ ...initial });
	let models: string[] = $state([]);
	let modelError = $state('');
	let loadingModels = $state(false);
	// A stored profile keeps its values; the catalog fills the fields only once another model is chosen.
	let catalogAppliedFor = catalogDefaults(initial.model)?.id;

	const local = $derived(values.provider === 'openai-compatible');
	const suggestion = $derived(catalogDefaults(values.model, values.role || undefined));
	const budgetWarning = $derived(thinkingBudgetWarning(values));
	const promptWarning = $derived(extraPromptWarning(values.extra_prompt));
	const priceNotice = $derived(pricingNotice(values.provider, values.model));
	const catalogModels = $derived(cloudModelOptions(values.provider));
	const errorFor = (field: string) => (form?.field === field ? form.message : undefined);
	const focusOnError = (field: string) => (input: HTMLElement) => {
		if (form?.field === field) input.focus();
	};
	/** Adds a warning shown next to the field to what the field's description already names. */
	const describedBy = (attrs: FieldAttrs, warningId: string | false) =>
		[attrs['aria-describedby'], warningId].filter(Boolean).join(' ') || undefined;

	$effect(() => {
		if (form?.savedSecret) values.api_key_ref = `secret:${form.savedSecret}`;
	});

	function applyCatalog() {
		const id = catalogDefaults(values.model)?.id;
		if (!id || id === catalogAppliedFor) return;
		catalogAppliedFor = id;
		values = withCatalogDefaults(values);
	}

	function changeProvider() {
		values.pool = defaultPool(values.provider);
		models = [];
		modelError = '';
	}

	const submit: SubmitFunction = ({ action }) => {
		if (action.search !== '?/models') return ({ update }) => update({ reset: false });
		loadingModels = true;
		return ({ result }) => {
			loadingModels = false;
			const list =
				result.type === 'success'
					? (result.data as { models?: string[]; modelError?: string })
					: undefined;
			models = list?.models ?? [];
			modelError =
				list?.modelError ??
				(list ? '' : 'Modelle laden fehlgeschlagen. Ausweg: Seite neu laden und erneut versuchen.');
		};
	};
</script>

<form id={formId} method="POST" action="?/save" use:enhance={submit}></form>

<div class="editor">
	<FormField label="Name" error={errorFor('name')}>
		{#snippet children(attrs)}
			<input
				{...attrs}
				form={formId}
				name="name"
				required
				autocomplete="off"
				bind:value={values.name}
				{@attach focusOnError('name')}
			/>
		{/snippet}
	</FormField>

	<FormField label="Provider" error={errorFor('provider')}>
		{#snippet children(attrs)}
			<select
				{...attrs}
				form={formId}
				name="provider"
				bind:value={values.provider}
				onchange={changeProvider}
			>
				{#each PROVIDERS as provider (provider.id)}
					<option value={provider.id}>{provider.label}</option>
				{/each}
			</select>
		{/snippet}
	</FormField>

	{#if local}
		<FormField
			label="Adresse (base_url)"
			hint="Mit /v1 am Ende. Standard-Ports: {DEFAULT_PORTS}; llama-swap und andere: eigener Port."
			error={errorFor('base_url')}
		>
			{#snippet children(attrs)}
				<input
					{...attrs}
					form={formId}
					name="base_url"
					type="url"
					required
					placeholder={BASE_URL_EXAMPLE}
					bind:value={values.base_url}
				/>
			{/snippet}
		</FormField>
	{/if}

	<div class="group">
		<FormField label="API-Key" hint={KEY_REF_HINT} error={errorFor('api_key_ref')}>
			{#snippet children(attrs)}
				<input
					{...attrs}
					form={formId}
					name="api_key_ref"
					list="{formId}-secrets"
					autocomplete="off"
					spellcheck="false"
					bind:value={values.api_key_ref}
					{@attach focusOnError('api_key_ref')}
				/>
			{/snippet}
		</FormField>
		<datalist id="{formId}-secrets">
			{#each data.secretNames as name (name)}<option value="secret:{name}"></option>{/each}
		</datalist>
		<p class="hint" role="status">
			{#if form?.savedSecret}Secret „{form.savedSecret}“ gespeichert und als Verweis eingetragen.{/if}
		</p>
		<details class="new-key" open={!!form?.secretError}>
			<summary>Neuen Key verschlüsselt speichern</summary>
			<SecretField error={form?.secretError} />
		</details>
	</div>

	<div class="group">
		<FormField
			label="Modell"
			hint={local
				? 'Aus der geladenen Liste wählen (Pfeil nach unten) oder frei eintragen.'
				: ['Modell-ID laut aktueller Doku des Anbieters.', priceNotice].filter(Boolean).join(' ')}
			error={errorFor('model')}
		>
			{#snippet children(attrs)}
				<div class="with-action">
					<input
						{...attrs}
						aria-describedby={describedBy(attrs, !!modelError && `${formId}-model-error`)}
						form={formId}
						name="model"
						list="{formId}-models"
						required
						autocomplete="off"
						spellcheck="false"
						bind:value={values.model}
						oninput={applyCatalog}
						{@attach focusOnError('model')}
					/>
					{#if local}
						<Button
							type="submit"
							form={formId}
							formaction="?/models"
							formnovalidate
							loading={loadingModels}>Modelle laden</Button
						>
					{/if}
				</div>
			{/snippet}
		</FormField>
		<datalist id="{formId}-models">
			{#if local}
				{#each models as model (model)}<option value={model}></option>{/each}
			{:else}
				{#each catalogModels as option (option.id)}
					<option value={option.id}>{option.label}</option>
				{/each}
			{/if}
		</datalist>
		{#if modelError}
			<p id="{formId}-model-error" class="error" role="alert">{modelError}</p>
		{/if}
		<p class="hint" role="status">{models.length ? `${models.length} Modelle geladen.` : ''}</p>
	</div>

	<fieldset>
		<legend
			>Verhalten{suggestion ? ` – vorbelegt aus dem Modell-Katalog (${suggestion.id})` : ''}</legend
		>
		<FormField
			label="Rolle"
			hint={suggestion?.reasons.role ??
				'Wählt die Katalog-Einstellungen je Rolle. Leer: die des Modells.'}
		>
			{#snippet children(attrs)}
				<select {...attrs} form={formId} name="role" bind:value={values.role}>
					<option value="">keine</option>
					{#each MODEL_ROLES as role (role)}<option value={role}>{role}</option>{/each}
				</select>
			{/snippet}
		</FormField>
		<FormField label="Thinking" hint={suggestion?.reasons.thinking ?? 'Leer: Default des Servers.'}>
			{#snippet children(attrs)}
				<select {...attrs} form={formId} name="thinking" bind:value={values.thinking}>
					<option value="">Default</option>
					<option value="on">an</option>
					<option value="off">aus</option>
				</select>
			{/snippet}
		</FormField>
		<div class="group">
			<FormField
				label="max_tokens"
				hint={suggestion?.reasons.maxTokens ??
					'Ausgabebudget je Schritt. Leer: Katalogwert oder Default des Servers.'}
				error={errorFor('max_tokens')}
			>
				{#snippet children(attrs)}
					<input
						{...attrs}
						aria-describedby={describedBy(attrs, !!budgetWarning && `${formId}-budget`)}
						form={formId}
						name="max_tokens"
						type="number"
						min="1"
						step="1"
						bind:value={values.max_tokens}
						{@attach focusOnError('max_tokens')}
					/>
				{/snippet}
			</FormField>
			{#if budgetWarning}<p id="{formId}-budget" class="warning">{budgetWarning}</p>{/if}
		</div>
		<FormField
			label="Prompt-Variante"
			hint={suggestion?.reasons.promptVariant ?? 'Leer: lokal kompakt, online voll.'}
		>
			{#snippet children(attrs)}
				<select {...attrs} form={formId} name="prompt_variant" bind:value={values.prompt_variant}>
					<option value="">automatisch</option>
					<option value="compact">kompakt</option>
					<option value="full">voll</option>
				</select>
			{/snippet}
		</FormField>
	</fieldset>

	{#if local}
		<FormField
			label="Temperatur"
			hint="Leer: Wert aus dem Katalog oder Default des Servers."
			error={errorFor('temperature')}
		>
			{#snippet children(attrs)}
				<input
					{...attrs}
					form={formId}
					name="temperature"
					type="number"
					min="0"
					max="2"
					step="0.05"
					bind:value={values.temperature}
					{@attach focusOnError('temperature')}
				/>
			{/snippet}
		</FormField>
	{/if}
	<FormField
		label="max_steps"
		hint="Höchstzahl der Schritte je Run; danach endet der Run mit einem Hinweis."
		error={errorFor('max_steps')}
	>
		{#snippet children(attrs)}
			<input
				{...attrs}
				form={formId}
				name="max_steps"
				type="number"
				min="1"
				step="1"
				placeholder={`${data.defaultMaxSteps}`}
				bind:value={values.max_steps}
				{@attach focusOnError('max_steps')}
			/>
		{/snippet}
	</FormField>
	<FormField
		label="Pool"
		hint="Der Runner lässt je Pool nur begrenzt viele Runs gleichzeitig laufen: lokal {data
			.poolLimits.local}, online {data.poolLimits.cloud}."
	>
		{#snippet children(attrs)}
			<select {...attrs} form={formId} name="pool" bind:value={values.pool}>
				{#each [...new Set(['local', 'cloud', values.pool])] as pool (pool)}
					<option value={pool}>{POOL_LABELS[pool] ?? pool}</option>
				{/each}
			</select>
		{/snippet}
	</FormField>
	<div class="group">
		<FormField
			label="Zusätzliche Anweisung (extra_prompt)"
			hint="Steht in jedem Run dieses Profils zuletzt im Prompt und hat Vorrang."
		>
			{#snippet children(attrs)}
				<textarea
					{...attrs}
					aria-describedby={describedBy(attrs, !!promptWarning && `${formId}-prompt`)}
					form={formId}
					name="extra_prompt"
					rows="4"
					bind:value={values.extra_prompt}></textarea>
			{/snippet}
		</FormField>
		{#if promptWarning}<p id="{formId}-prompt" class="warning">{promptWarning}</p>{/if}
	</div>

	{#if form?.message && form.field === ''}<p class="error" role="alert">{form.message}</p>{/if}
	<div class="actions">
		<Button type="submit" variant="primary" form={formId}>Speichern</Button>
		<a class="btn" href="/settings/profiles">Abbrechen</a>
	</div>
</div>

<style>
	.editor {
		display: grid;
		gap: var(--space-3);
		max-width: 64ch;
		margin-top: var(--space-4);
	}
	fieldset {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	legend {
		padding-inline: var(--space-1);
		font-weight: 560;
	}
	.group {
		display: grid;
		gap: var(--space-1);
	}
	.with-action {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.with-action input {
		flex: 1 1 16ch;
		width: auto;
		min-width: 0;
	}
	.hint,
	.warning,
	.error {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.hint {
		color: var(--text-muted);
	}
	.warning {
		color: var(--status-waiting);
		font-weight: 560;
	}
	.error {
		color: var(--status-failed);
		font-weight: 560;
	}
	.new-key summary {
		cursor: pointer;
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
	}
	:global(.editor .field p) {
		overflow-wrap: anywhere;
	}
</style>
