<script lang="ts">
	import EmptyState from '$lib/ui/EmptyState.svelte';
</script>

<EmptyState title="Noch kein Projekt">
	Leg ein Projekt an; darin entstehen deine Tickets, und Agents arbeiten sie ab.
	{#snippet action()}<a class="btn btn-primary" href="/projects">Projekt anlegen</a>{/snippet}
</EmptyState>
