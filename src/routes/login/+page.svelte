<script lang="ts">
	import { t } from '$lib/i18n/t';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1>{t('login.title')}</h1>
{#if form?.error}<p role="alert">{form.error}</p>{/if}
<form method="POST">
	<p>
		<label
			>{t('auth.name')}
			<input name="name" value={form?.name ?? ''} required autocomplete="username" /></label
		>
	</p>
	<p>
		<label
			>{t('auth.password')}
			<input type="password" name="password" required autocomplete="current-password" /></label
		>
	</p>
	<button>{t('login.submit')}</button>
</form>
