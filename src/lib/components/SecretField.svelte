<!--
	Secret field: shows only "set" · replace · delete, never the value. Without `name` it creates a new secret.
	The page must provide the actions `setSecret` and `deleteSecret` (see routes/settings/secrets).
	Plain markup without styling of its own — the design system takes care of the look.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';

	type Props = {
		/** Name of a stored secret; without it the field creates a new one. */
		name?: string;
		/** Last change (UTC), for stored secrets only. */
		updatedAt?: string;
		/** Error of the last action, if it concerned this field. */
		error?: { code: string; message: string; hint: string };
	};
	let { name, updatedAt, error }: Props = $props();

	const id = $props.id();
	// An error for a stored secret opens its input (also without JS after the reload); replace/cancel override that.
	// Only relevant with `name` — the form for a new secret is always open.
	let replacing = $derived(!!error);
	const nameInvalid = $derived(
		['secret_name_invalid', 'secret_name_is_value', 'secret_exists'].includes(error?.code ?? '')
	);
	let replaceButton: HTMLButtonElement | undefined = $state();

	/** Closes the replace form; focus would be lost with it, so it returns to the replace button. */
	async function closeReplace() {
		replacing = false;
		await tick();
		replaceButton?.focus();
	}
	const focusIf = (when: () => boolean) => (el: HTMLElement) => {
		if (when()) el.focus();
	};
</script>

{#if name && !replacing}
	<p>
		<strong>{name}</strong> — gesetzt, geändert {updatedAt} UTC
		<button type="button" onclick={() => (replacing = true)} bind:this={replaceButton}
			>Ersetzen</button
		>
	</p>
	<form
		method="POST"
		action="?/deleteSecret"
		use:enhance={({ cancel }) => {
			if (
				!confirm(
					`Secret „${name}“ löschen? Der Wert ist danach unwiederbringlich weg; Verweise secret:${name} schlagen fehl.`
				)
			)
				cancel();
		}}
	>
		<input type="hidden" name="field" value={name} />
		<button>Löschen</button>
	</form>
{:else}
	<form
		method="POST"
		action="?/setSecret"
		use:enhance={({ cancel }) => {
			if (
				name &&
				!confirm(`Secret „${name}“ ersetzen? Der bisherige Wert ist danach unwiederbringlich weg.`)
			)
				return cancel();
			return async ({ result, update }) => {
				await update(); // on success this resets the focus to the page, so close only afterwards
				if (result.type === 'success' && name) closeReplace();
			};
		}}
	>
		<input type="hidden" name="field" value={name ?? ''} />
		{#if name}
			<input type="hidden" name="name" value={name} />
			<input type="hidden" name="replace" value="1" />
		{:else}
			<label>
				Name
				<input
					name="name"
					required
					autocomplete="off"
					aria-invalid={nameInvalid}
					aria-describedby={nameInvalid ? `${id}-error` : undefined}
					{@attach focusIf(() => nameInvalid)}
				/>
			</label>
		{/if}
		<label>
			{name ? `Neuer Wert für ${name}` : 'Wert'}
			<!-- focus moves to the value when replace opens and on an error -->
			<input
				type="password"
				name="value"
				required
				autocomplete="new-password"
				aria-invalid={!!error && !nameInvalid}
				aria-describedby={error && !nameInvalid ? `${id}-error` : undefined}
				{@attach focusIf(() => (!!name || !!error) && !nameInvalid)}
			/>
		</label>
		<button>Speichern</button>
		{#if name}<button type="button" onclick={closeReplace}>Abbrechen</button>{/if}
		{#if error}<p id="{id}-error" role="alert">{error.message} {error.hint}</p>{/if}
	</form>
{/if}
