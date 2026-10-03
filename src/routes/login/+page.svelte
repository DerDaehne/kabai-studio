<script lang="ts">
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1>kabai studio — Anmelden</h1>
{#if form?.error}<p role="alert">{form.error}</p>{/if}
<form method="POST">
	<p>
		<label
			>Name <input name="name" value={form?.name ?? ''} required autocomplete="username" /></label
		>
	</p>
	<p>
		<label
			>Passwort <input
				type="password"
				name="password"
				required
				autocomplete="current-password"
			/></label
		>
	</p>
	<button>Anmelden</button>
</form>
