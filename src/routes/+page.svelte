<script lang="ts">
	import NoProject from '$lib/components/NoProject.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>kabai studio</h1>
{#if data.live?.projects.length}
	<p>Early development — nothing to see yet.</p>
{:else}
	<NoProject />
{/if}
<form method="POST" action="/logout">
	Angemeldet als {data.user.name} · <button>Abmelden</button>
</form>
