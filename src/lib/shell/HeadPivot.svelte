<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { revealActiveTitle } from '$lib/ui/motion';
	import { live, openQuestionsLabel } from './live.svelte';
	import { shell } from './shell.svelte';

	type Place = { href: string; title: string; covers: (path: string) => boolean };
	const ticketPage = /^\/p\/[^/]+\/t\//;
	/** The places of the app in their fixed order; a deep link counts as the place it lies in. Titles show lower case. */
	const places: Place[] = [
		{ href: '/', title: 'kabai studio', covers: (path) => path === '/' },
		{ href: '/takt', title: 'Takt', covers: (path) => path.startsWith('/takt') },
		{
			href: '/board',
			title: 'Board',
			covers: (path) => path.startsWith('/board') || ticketPage.test(path)
		},
		{
			href: '/projects',
			title: 'Projekte',
			covers: (path) => path.startsWith('/projects') || path.startsWith('/p/')
		},
		{ href: '/settings', title: 'Einstellungen', covers: (path) => path.startsWith('/settings') }
	];
	const path = $derived(page.url.pathname);
	const current = $derived(places.find((place) => place.covers(path)));

	const openQuestionsOf = (place: Place) => (place.href === '/takt' ? live.openQuestions : 0);
	// a bare number would be read out as "takt 2"; with a count the link's name says what is counted
	const accessibleName = (place: Place) =>
		openQuestionsOf(place)
			? `${place.title}, ${openQuestionsLabel(openQuestionsOf(place))}`
			: undefined;

	let strip = $state<HTMLElement>();

	function reveal(jump: boolean) {
		if (strip) revealActiveTitle(strip, strip.querySelector('[aria-current]'), jump);
	}

	let placed = false;
	$effect(() => {
		void current;
		reveal(!placed);
		placed = true;
	});
	// Barlow arrives after the first layout (font-display: swap) and changes every width
	onMount(() => void document.fonts?.ready.then(() => reveal(true)));
</script>

<svelte:window onresize={() => reveal(true)} />

<header class="head">
	<nav class="titles" aria-label="Ansichten" bind:this={strip} data-title-row>
		{#each places as place (place.href)}
			<a
				href={place.href}
				aria-current={place === current ? (place.href === path ? 'page' : 'true') : undefined}
				aria-label={accessibleName(place)}
			>
				{#if place.href === '/'}<b>kabai</b> studio{:else}{place.title}{/if}
				{#if openQuestionsOf(place)}<span class="count">{openQuestionsOf(place)}</span>{/if}
			</a>
		{/each}
		<!-- room for the last title to reach the left edge as well -->
		<span class="end" aria-hidden="true"></span>
	</nav>
	{#key shell.signals}
		{#if shell.signals}<span class="wave" aria-hidden="true"></span>{/if}
	{/key}
</header>

<style>
	.head {
		position: sticky;
		top: 0;
		z-index: 10;
		padding-top: var(--space-2);
		background: var(--bg);
		view-transition-name: head;
	}
	.titles {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: var(--space-6);
		height: calc(1.25em + var(--space-1));
		padding: 0 var(--gutter) var(--space-1);
		overflow: auto hidden;
		scrollbar-width: none;
		font-size: var(--type-nav-active);
		white-space: nowrap;
	}
	.titles::-webkit-scrollbar {
		display: none;
	}
	a {
		flex: none;
		color: var(--text-muted);
		font-size: var(--type-nav);
		font-weight: var(--weight-light);
		line-height: 1.2;
		text-decoration: none;
		text-transform: lowercase;
		transform-origin: left bottom;
		transition:
			scale var(--motion-short) var(--ease-inout),
			translate var(--motion-short) var(--ease-inout);
	}
	a:hover {
		color: var(--text);
	}
	/* the row clips vertically, so the scaled title needs an inner ring, like a tile's */
	a:focus-visible {
		outline-offset: -2px;
		box-shadow: none;
	}
	a[aria-current] {
		scale: var(--active-scale, 1);
		color: var(--text);
	}
	a[aria-current] ~ a {
		translate: var(--active-room, 0) 0;
	}
	b {
		font-weight: var(--weight-semibold);
	}
	.count {
		display: inline-block;
		min-width: 1.4em;
		margin-left: var(--space-1);
		padding: 0 var(--space-1);
		background: var(--status-waiting-tint);
		color: var(--status-waiting);
		font-size: var(--type-label);
		font-weight: var(--weight-medium);
		line-height: 1.5;
		text-align: center;
		vertical-align: super;
	}
	.end {
		flex: 0 0 100%;
	}
	.wave {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.wave::before {
		content: '';
		position: absolute;
		inset: 0;
		width: 30%;
		background: linear-gradient(90deg, transparent, var(--aura-waiting), transparent);
		transform: translateX(-100%);
		animation: wave var(--dur-sweep) var(--ease-inout) both;
	}
	@keyframes wave {
		to {
			transform: translateX(400%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.wave {
			display: none;
		}
	}
	:global(:root[data-motion='reduced']) .wave {
		display: none;
	}
	:global(::view-transition-group(head)) {
		animation: none;
	}
</style>
