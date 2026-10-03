<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>kabai studio einrichten</h1>
<p>Lege den Owner-Account an. Den Setup-Token gibt der Server beim Start auf der Konsole aus.</p>
{#if form?.error}<p role="alert">{form.error}</p>{/if}
<form method="POST">
	<p>
		<label>Setup-Token <input name="token" value={data.token} required autocomplete="off" /></label>
	</p>
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
				minlength="12"
				autocomplete="new-password"
			/></label
		>
	</p>
	<p>
		<label
			>Passwort wiederholen <input
				type="password"
				name="confirm"
				required
				autocomplete="new-password"
			/></label
		>
	</p>
	<button>Owner anlegen</button>
</form>
