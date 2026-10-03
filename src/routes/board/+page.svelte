<script lang="ts">
	import NoProject from '$lib/components/NoProject.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Board</h1>
{#if data.live?.projects.length}
	<EmptyState title="Board folgt"
		>Diese Ansicht entsteht als Nächstes; die Docks und die Befehlszeile gelten schon.</EmptyState
	>
{:else}
	<NoProject />
{/if}
