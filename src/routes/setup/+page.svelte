<script lang="ts">
	import { t } from '$lib/i18n/t';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>{t('setup.title')}</h1>
<p>{t('setup.intro')}</p>
{#if form?.error}<p role="alert">{form.error}</p>{/if}
<form method="POST">
	<p>
		<label
			>{t('setup.token')}
			<input name="token" value={data.token} required autocomplete="off" /></label
		>
	</p>
	<p>
		<label
			>{t('auth.name')}
			<input name="name" value={form?.name ?? ''} required autocomplete="username" /></label
		>
	</p>
	<p>
		<label
			>{t('auth.password')}
			<input
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
			>{t('setup.repeatPassword')}
			<input type="password" name="confirm" required autocomplete="new-password" /></label
		>
	</p>
	<button>{t('setup.submit')}</button>
</form>
