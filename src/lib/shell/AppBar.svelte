<script lang="ts">
	import { goto } from '$app/navigation';
	import Kbd from '$lib/ui/Kbd.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import RoundButton from '$lib/ui/RoundButton.svelte';
	import HaltControl from './HaltControl.svelte';
	import { splitPending } from './keys';
	import { live, runnerState } from './live.svelte';
	import { keyboard } from './router.svelte';
	import { shell } from './shell.svelte';

	let {
		openCommandLine,
		openKeys
	}: { openCommandLine: (mode: string) => void; openKeys: () => void } = $props();

	const runner = $derived(runnerState(live.halt, shell.agents));
	const pending = $derived(splitPending(shell.pendingKeys));

	/** Back where you came from; a page opened directly goes back to the start. */
	function back() {
		if (history.length > 1) history.back();
		else void goto('/');
	}
</script>

<footer class="appbar" aria-label="App-Leiste">
	<div class="status">
		<p class="runner">
			<span class="name">runner</span>
			<Tag tone={runner.tone}>{runner.word}</Tag>
		</p>
		{#if !keyboard.singleKeys}
			<p class="keys">nur mit <Kbd key="Alt" /></p>
		{/if}
		{#if shell.pendingKeys}
			<p class="keys">
				{#each [...pending.count, ...pending.prefix] as key, index (index)}<Kbd
						{key}
						active
					/>{/each}
				<Kbd key="Escape" /> abbrechen
			</p>
		{/if}
	</div>
	<div class="commands">
		<span class="phone"><RoundButton icon="back" word="zurück" onclick={back} /></span>
		<HaltControl openResumePrompt={() => openCommandLine(':fortsetzen ')} />
		<RoundButton
			icon="command"
			word="befehl"
			title="Befehl oder Suche (: oder /)"
			onclick={() => openCommandLine('')}
		/>
		<RoundButton icon="keys" word="tasten" title="Alle Tasten (?)" onclick={openKeys} />
	</div>
</footer>

<style>
	.appbar {
		position: fixed;
		inset: auto 0 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		height: calc(var(--appbar-h) + env(safe-area-inset-bottom));
		padding: 0 var(--gutter) env(safe-area-inset-bottom);
		border-top: 1px solid var(--rule);
		background: var(--bg);
		view-transition-name: app-bar;
	}
	.status {
		/* contains the hidden key names of Kbd (position: absolute), so they cannot widen the page */
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.name {
		color: var(--text-muted);
		font-size: var(--type-label);
	}
	.keys {
		display: flex;
		align-items: center;
		gap: 3px;
		color: var(--text-muted);
		font-size: var(--type-label);
	}
	.commands {
		display: flex;
		flex: none;
	}
	.phone {
		display: none;
	}
	/* Phones: the back command comes first, in thumb reach; the runner keeps its word, its label goes to screen readers */
	@media (max-width: 759px) {
		.appbar {
			gap: var(--space-2);
			padding-inline: var(--space-2);
		}
		.phone {
			display: contents;
		}
		.name {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
	}
	:global(::view-transition-group(app-bar)) {
		animation: none;
	}
</style>
