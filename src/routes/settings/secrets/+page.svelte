<script lang="ts">
	import SecretField from '$lib/components/SecretField.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const errorFor = (field: string) => (form?.code !== undefined && form.field === field ? form : undefined);
</script>

<h1>Secrets</h1>
<p>
	API-Keys und Tokens, verschlüsselt gespeichert. Nach dem Speichern zeigt Studio einen Wert nie wieder an — nur ersetzen
	oder löschen. In Agent-Profilen und MCP-Servern verweist <code>secret:&lt;name&gt;</code> darauf.
</p>
<ul>
	{#each data.secrets as secret (secret.name)}
		<li><SecretField name={secret.name} updatedAt={secret.updated_at} error={errorFor(secret.name)} /></li>
	{:else}
		<li>Noch keine Secrets gespeichert.</li>
	{/each}
</ul>
<h2>Neues Secret</h2>
<SecretField error={errorFor('')} />
