<script lang="ts">
	import { page } from '$app/state';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	const missing = $derived(page.status === 404);
</script>

<svelte:head><title>{missing ? 'Nicht gefunden' : 'Fehler'} – kabai studio</title></svelte:head>

<EmptyState title={missing ? 'Diese Ansicht gibt es nicht' : `Fehler ${page.status}`}>
	{missing
		? 'Die Adresse ist falsch oder die Ansicht ist noch nicht gebaut.'
		: (page.error?.message ?? 'Unbekannter Fehler.')}
	{#snippet action()}<a class="btn" href="/">Zu den Projekten</a>{/snippet}
</EmptyState>
