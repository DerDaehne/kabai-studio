<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/ui/Icon.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { appbar } from '$lib/rekta/rekta';
	import { standingBanner } from './banner.svelte';
	import { connection } from './connection.svelte';
	import HaltControl from './HaltControl.svelte';
	import { splitPending } from './keys';
	import { live, runnerState } from './live.svelte';
	import { keyboard } from './router.svelte';
	import { shell } from './shell.svelte';

	let {
		openCommandLine,
		openKeys
	}: { openCommandLine: (mode: string) => void; openKeys: () => void } = $props();

	const runner = $derived(runnerState(live.halt, shell.agents, connection.lost));
	const pending = $derived(splitPending(shell.pendingKeys));
	const banner = $derived(standingBanner());

	/** Back where you came from; a page opened directly goes back to the start. */
	function back() {
		if (history.length > 1) history.back();
		else void goto('/');
	}

	let bar: HTMLElement;
	$effect(() => appbar(bar).destroy);
</script>

<footer
	class="rk-appbar"
	aria-label="App-Leiste"
	bind:this={bar}
	data-rk-state={banner?.status === 'error' ? 'halted' : banner ? 'paused' : undefined}
>
	<button type="button" class="rk-ab rk-ab-back" onclick={back}>
		<Icon name="back" size={20} /><span>zurück</span>
	</button>
	<span class="rk-ab-status" data-tone={runner.tone}>
		<i class="rk-pulse" aria-hidden="true"></i>
		<span class="rk-ab-k">{runner.word}</span>
	</span>
	<div class="rk-ab-mid">
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
	<HaltControl openResumePrompt={() => openCommandLine(':fortsetzen ')} />
	<button
		type="button"
		class="rk-ab"
		data-rk-priority="pinned"
		title="Befehl oder Suche (: oder /)"
		onclick={() => openCommandLine('')}
	>
		<Icon name="command" size={20} /><span>befehl</span>
	</button>
	<button
		type="button"
		class="rk-ab"
		data-rk-priority="1"
		title="Alle Tasten (?)"
		onclick={openKeys}
	>
		<Icon name="keys" size={20} /><span>tasten</span>
	</button>
	<button type="button" class="rk-ab rk-ab-more" hidden>
		<Icon name="more" size={20} /><span>mehr</span>
	</button>
</footer>

<style>
	.rk-appbar {
		view-transition-name: app-bar;
	}
	.rk-ab-mid {
		margin-left: var(--space-4);
	}
	.keys {
		display: inline-flex;
		margin-right: var(--space-4);
		align-items: center;
		gap: var(--space-1);
		color: var(--text-muted);
		font-size: var(--type-label);
	}
	:global(::view-transition-group(app-bar)) {
		animation: none;
	}
</style>
