<script lang="ts">
	import ProfileForm from './ProfileForm.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<a href="/settings/profiles">← Agent-Profile</a>
<h1>{data.id === 'new' ? 'Neues Agent-Profil' : `Profil „${data.values.name}“`}</h1>
<!-- the same page serves another profile after a navigation, so the form starts fresh for each one -->
{#key data.id}
	<ProfileForm {data} {form} />
{/key}
