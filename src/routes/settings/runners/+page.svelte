<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { RUNNERS_DEPENDENCY } from '$lib/live';
	import { t } from '$lib/i18n/t';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Crumb from '$lib/ui/Crumb.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import { toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const connectId = $props.id();

	let pairing = $state({ code: '', command: '' });
	let connectOpen = $state(false);
	let disconnecting = $state<{ id: number; name: string } | undefined>();

	// The machine shows up only after its own command ran, so the list is read again once the dialog closes.
	function setConnectOpen(open: boolean) {
		connectOpen = open;
		if (!open) invalidateAll();
	}

	$effect(() =>
		onLiveEvent((event) => {
			if (event.type.startsWith('machine.')) void invalidateLive(RUNNERS_DEPENDENCY);
		})
	);

	const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
	const keys = (list: string[]) => (list.length ? list.join(', ') : '–');

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(pairing.command);
			toast(t('runners.dialog.copied'), 'success');
		} catch {
			toast(t('runners.dialog.copyFailed'), 'error');
		}
	}

	// The disconnected row and the button that opened the sheet are gone, so focus goes back to the page's action.
	async function focusConnect() {
		await tick();
		document.getElementById(connectId)?.focus();
	}
</script>

<Crumb href="/settings" label={t('runners.back')} />
<h1>{t('runners.title')}</h1>
<p class="intro">{t('runners.intro')}</p>

<form
	method="POST"
	action="?/connect"
	use:enhance={() =>
		async ({ result }) => {
			if (result.type !== 'success' || !result.data?.pairing) return;
			pairing = result.data.pairing as typeof pairing;
			connectOpen = true;
		}}
>
	<Button type="submit" variant="primary" id={connectId}>{t('runners.connect')}</Button>
</form>

{#if form && 'message' in form}<p class="error" role="alert">{form.message}</p>{/if}

{#if data.runners.length}
	<ul class="runners" aria-label={t('runners.title')}>
		{#each data.runners as runner (runner.id)}
			<li>
				<span class="name">{runner.name}</span>
				<span class="seen">
					{#if runner.connection}
						{t('runners.connected', {
							time: utc(runner.connection.connectedAt),
							slots: runner.connection.slots,
							workspaces: keys(runner.connection.workspaces),
							agents: keys(runner.connection.agents)
						})}
					{:else if runner.last_seen_at}
						{t('runners.notConnected', { time: utc(runner.last_seen_at.replace(' ', 'T')) })}
					{:else}
						{t('runners.neverConnected')}
					{/if}
				</span>
				<Button variant="ghost" size="sm" onclick={() => (disconnecting = runner)}
					>{t('runners.disconnect')}</Button
				>
			</li>
		{/each}
	</ul>
{:else}
	<EmptyState title={t('runners.empty.title')}>{t('runners.empty.body')}</EmptyState>
{/if}

<Dialog bind:open={() => connectOpen, setConnectOpen} title={t('runners.connect')}>
	<div class="pairing">
		<p>{t('runners.dialog.intro')}</p>
		<p>{t('runners.dialog.code')}: <strong class="mono code">{pairing.code}</strong></p>
		<FormField label={t('runners.dialog.command')}>
			{#snippet children(attrs)}
				<!-- autofocus is intended: showModal() puts the first focus on the command, not on the close button -->
				<!-- svelte-ignore a11y_autofocus -->
				<textarea
					{...attrs}
					class={[attrs.class, 'mono command']}
					rows="2"
					readonly
					spellcheck="false"
					autofocus
					value={pairing.command}
					onfocus={(event) => event.currentTarget.select()}></textarea>
			{/snippet}
		</FormField>
		<Button onclick={copyCommand}>{t('runners.dialog.copy')}</Button>
		<p class="hint">{t('runners.dialog.after')}</p>
	</div>
</Dialog>

<Dialog
	variant="sheet"
	bind:open={() => disconnecting !== undefined, (open) => !open && (disconnecting = undefined)}
	title={t('runners.disconnect.title', { name: disconnecting?.name ?? '' })}
>
	<p>{t('runners.disconnect.body')}</p>
	{#snippet footer()}
		<!-- svelte-ignore a11y_autofocus -->
		<Button variant="primary" autofocus onclick={() => (disconnecting = undefined)}
			>{t('runners.cancel')}</Button
		>
		<form
			method="POST"
			action="?/disconnect"
			use:enhance={() => {
				disconnecting = undefined;
				return async ({ update }) => {
					await update();
					await focusConnect();
				};
			}}
		>
			<input type="hidden" name="id" value={disconnecting?.id} />
			<Button type="submit">{t('runners.disconnect')}</Button>
		</form>
	{/snippet}
</Dialog>

<style>
	.intro {
		max-width: 64ch;
		margin-block: var(--space-2) var(--space-4);
		color: var(--text-muted);
	}
	.runners {
		max-width: 72ch;
		margin-top: var(--space-4);
		padding: 0;
		list-style: none;
	}
	.runners li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding-block: var(--space-2);
		border-block-end: 1px solid var(--rule);
	}
	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}
	.seen {
		flex: 1;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.error {
		margin-top: var(--space-2);
		color: var(--status-failed);
	}
	.pairing {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}
	.pairing > :global(*) {
		max-width: 100%;
	}
	.pairing :global(.field) {
		width: 100%;
	}
	.code {
		font-size: var(--text-lg);
		letter-spacing: 0.08em;
	}
	.command {
		resize: none;
		overflow-wrap: anywhere;
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	form {
		display: contents;
	}
</style>
