<!--
	Secret-Feld: zeigt nur „gesetzt“ · Ersetzen · Löschen, nie den Wert. Ohne `name` legt es ein neues Secret an.
	Die Seite muss die Actions `setSecret` und `deleteSecret` bereitstellen (siehe routes/settings/secrets).
	Schlichtes Markup ohne eigenes Styling — das Design-System übernimmt das Aussehen.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';

	type Props = {
		/** Name eines gespeicherten Secrets; fehlt er, legt das Feld ein neues an. */
		name?: string;
		/** Letzte Änderung (UTC) — nur bei gespeicherten Secrets. */
		updatedAt?: string;
		/** Fehler der letzten Aktion, falls sie dieses Feld betraf. */
		error?: { code: string; message: string; hint: string };
	};
	let { name, updatedAt, error }: Props = $props();

	const id = $props.id();
	// Ein Fehler zu einem gespeicherten Secret öffnet dessen Eingabe (auch ohne JS nach dem Neuladen); Ersetzen/Abbrechen überschreiben
	// das. Nur mit `name` von Bedeutung — das Formular für ein neues Secret ist immer offen.
	let replacing = $derived(!!error);
	const nameInvalid = $derived(
		['secret_name_invalid', 'secret_name_is_value', 'secret_exists'].includes(error?.code ?? '')
	);
	let replaceButton: HTMLButtonElement | undefined = $state();

	/** Schließt das Ersetzen-Formular; der Fokus ginge mit ihm verloren, darum zurück auf „Ersetzen“. */
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
				await update(); // setzt den Fokus bei Erfolg zurück auf die Seite — darum erst danach schließen
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
			<!-- Fokus: beim Öffnen von „Ersetzen“ und bei einem Fehler zum Wert -->
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
