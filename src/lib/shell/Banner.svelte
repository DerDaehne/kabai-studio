<script lang="ts">
	import { onMount } from 'svelte';
	import type { BannerState } from './banner.svelte';

	/** The lasting state at the top of the page; both live regions stay mounted so the next state is announced. */
	let { standing }: { standing: BannerState | null } = $props();

	let element: HTMLElement;

	// The public hook `--rk-banner-h`: what scroll-padding, the sticky head and the toasts keep clear of
	onMount(() => {
		const root = document.documentElement;
		const publish = () =>
			root.style.setProperty('--rk-banner-h', `${Math.ceil(element.offsetHeight)}px`);
		const observer = new ResizeObserver(publish);
		observer.observe(element);
		return () => {
			observer.disconnect();
			root.style.removeProperty('--rk-banner-h');
		};
	});
</script>

<div
	class="rk-banner"
	bind:this={element}
	data-status={standing?.status}
	data-rk-phase={standing ? undefined : 'clear'}
>
	<div class="rk-banner-live">
		<p role="alert">
			{#if standing?.alert}{@render message(standing)}{/if}
		</p>
		<p role="status">
			{#if standing && !standing.alert}{@render message(standing)}{/if}
		</p>
	</div>
	<p class="rk-actions">
		{#if standing}
			{@const action = standing.action}
			{#if 'href' in action}
				<a class="rk-btn" href={action.href}>{action.label}</a>
			{:else}
				<button type="button" class="rk-btn" onclick={action.run}>{action.label}</button>
			{/if}
		{/if}
	</p>
</div>

{#snippet message(state: BannerState)}
	<span class="rk-banner-head"><span class="rk-banner-word">{state.word}</span></span>
	<span class="rk-banner-msg">{state.text}</span>
{/snippet}
