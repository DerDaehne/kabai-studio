<script lang="ts">
	import { page } from '$app/state';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	const missing = $derived(page.status === 404);
	// A matched route that failed (e.g. an unknown ticket id) has its own message; only a truly unmatched
	// address — route.id stays null — gets the generic "not built yet" text.
	const routeMatched = $derived(page.route.id !== null);
	const onTicket = $derived(page.route.id?.startsWith('/p/') ?? false);
</script>

<svelte:head><title>{missing ? 'Nicht gefunden' : 'Fehler'} – kabai studio</title></svelte:head>

<EmptyState title={missing ? 'Diese Ansicht gibt es nicht' : `Fehler ${page.status}`}>
	{missing && !routeMatched
		? 'Die Adresse ist falsch oder die Ansicht ist noch nicht gebaut.'
		: (page.error?.message ?? 'Unbekannter Fehler.')}
	{#snippet action()}
		<a class="btn" href="/">Zum Stellwerk</a>
		{#if onTicket}<a class="btn" href="/board">Zum Board</a>{/if}
	{/snippet}
</EmptyState>
