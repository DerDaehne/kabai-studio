<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/ui/Icon.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { fitAppBar } from './appbar-overflow';
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
	let more: HTMLButtonElement;
	let menu: HTMLElement;
	/** The controls that did not fit; the menu repeats their words. */
	let moved = $state.raw<HTMLElement[]>([]);

	const layout = () => (moved = fitAppBar(bar, more));
	const wordOf = (control: HTMLElement) => control.textContent?.trim() ?? '';

	// Re-measure when the bar's width changes and when the runner's word does (it is the one text that varies)
	$effect(() => {
		void runner.word;
		layout();
		const observer = new ResizeObserver(layout);
		observer.observe(bar);
		void document.fonts?.ready.then(layout);
		return () => observer.disconnect();
	});

	function chosen(control: HTMLElement) {
		menu.hidePopover();
		control.click();
	}

	function arrowsInMenu(event: KeyboardEvent) {
		const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		items.at(next % items.length)?.focus();
	}
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
	<button
		type="button"
		class="rk-ab rk-ab-more"
		bind:this={more}
		hidden
		aria-haspopup="menu"
		popovertarget="appbar-more"
	>
		<Icon name="more" size={20} /><span>mehr</span>
	</button>
	<div
		id="appbar-more"
		class="rk-float more-menu"
		popover="auto"
		role="menu"
		tabindex="-1"
		bind:this={menu}
		onkeydown={arrowsInMenu}
		ontoggle={(event) => {
			if (event.newState === 'open') menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
		}}
	>
		{#each moved as control (control)}
			<button type="button" role="menuitem" class="rk-menu-item" onclick={() => chosen(control)}>
				{wordOf(control)}
			</button>
		{/each}
	</div>
</footer>

<style>
	.rk-appbar {
		view-transition-name: app-bar;
	}
	/* Takes the room the controls leave over, and gives it up first when the bar is full */
	.rk-ab-status {
		margin-right: 0;
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
	/* Above the bar, at its trailing edge, where "mehr" is */
	.more-menu {
		inset: auto var(--space-2)
			calc(var(--rk-appbar-height) + env(safe-area-inset-bottom) + var(--space-2)) auto;
	}
	:global(::view-transition-group(app-bar)) {
		animation: none;
	}
</style>
