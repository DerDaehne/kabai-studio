<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>kabai studio</h1>
<p>Early development — nothing to see yet.</p>
<form method="POST" action="/logout">
	Angemeldet als {data.user.name} · <button>Abmelden</button>
</form>
