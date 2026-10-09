<script lang="ts">
	import { enhance } from '$app/forms';
	import { POOL_LABELS, PROVIDERS } from '$lib/agents/profile-defaults';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let deleting = $state({ id: 0, name: '' });
	let confirmOpen = $state(false);
	const providerLabel = (id: string | null) =>
		PROVIDERS.find((provider) => provider.id === id)?.label ?? id ?? '–';
</script>

<h1>Agent-Profile</h1>
<p class="intro">
	Ein Profil legt fest, mit welchem Modell ein Agent arbeitet: lokal über einen OpenAI-kompatiblen
	Server oder online bei einem Anbieter.
</p>
<a class="btn btn-primary" href="/settings/profiles/new">Neues Profil</a>

{#if data.profiles.length}
	<ul class="profiles">
		{#each data.profiles as profile (profile.id)}
			<li>
				<a class="name" href="/settings/profiles/{profile.id}">{profile.name}</a>
				<span class="meta">
					{providerLabel(profile.provider)} · <span class="mono">{profile.model}</span> · Pool
					{POOL_LABELS[profile.pool] ?? profile.pool}
				</span>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						deleting = profile;
						confirmOpen = true;
					}}>Löschen</Button
				>
				{#if form?.id === profile.id}<p class="error" role="alert">{form.message}</p>{/if}
			</li>
		{/each}
	</ul>
{:else}
	<EmptyState title="Noch keine Agent-Profile">
		Ohne Profil kann kein Agent arbeiten. Lege eines für deinen lokalen Modell-Server oder einen
		Cloud-Anbieter an.
	</EmptyState>
{/if}

<Dialog bind:open={confirmOpen} title="Profil „{deleting.name}“ löschen?">
	<p>
		Beendete Runs behalten ihren Verlauf. Solange Runs mit diesem Profil warten oder laufen, lässt
		es sich nicht löschen.
	</p>
	{#snippet footer()}
		<Button onclick={() => (confirmOpen = false)}>Abbrechen</Button>
		<form
			method="POST"
			action="?/delete"
			use:enhance={() => {
				confirmOpen = false;
			}}
		>
			<input type="hidden" name="id" value={deleting.id} />
			<Button type="submit" variant="danger">Löschen</Button>
		</form>
	{/snippet}
</Dialog>

<style>
	.intro {
		max-width: 64ch;
		margin-block: var(--space-2) var(--space-4);
		color: var(--text-muted);
	}
	.profiles {
		display: grid;
		gap: var(--space-2);
		max-width: 72ch;
		margin-top: var(--space-4);
		padding: 0;
		list-style: none;
	}
	.profiles li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.name {
		font-weight: 620;
	}
	.meta {
		flex: 1;
		min-width: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.error {
		flex-basis: 100%;
		color: var(--status-failed);
	}
	form {
		display: contents;
	}
</style>
