<script lang="ts" module>
	/** One facet of a pivot; `width` is its CSS width side by side in the panorama, `count` a number shown with it. */
	export type Facet = { id: string; label: string; count?: number; width?: string };
</script>

<script lang="ts">
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { glidePivot, revealActiveTitle } from './motion';
	import { sideways } from './sideways';

	type Props = {
		facets: Facet[];
		/** The id of the facet in front; bind it, or set it and follow `onchange`. */
		active?: string;
		/** Reports a switch by the human (tab, arrow, h/l), never a change of `active` from outside. */
		onchange?: (id: string) => void;
		/** Names the tab list. */
		label: string;
		/** Keeps the tabs and one facet at every width, until the panorama has a rule for its height and wheel. */
		narrow?: boolean;
		panel: Snippet<[Facet]>;
	};
	let {
		facets,
		active = $bindable(facets[0]?.id),
		onchange,
		label,
		narrow = false,
		panel
	}: Props = $props();

	const uid = $props.id();
	const tabId = (facet: Facet) => `${uid}-tab-${facet.id}`;
	const panelId = (facet: Facet) => `${uid}-panel-${facet.id}`;
	const headingId = (facet: Facet) => `${uid}-heading-${facet.id}`;

	// The styles' media query lays the panorama out before hydration; this one switches the roles to match.
	const wideScreen = new MediaQuery('min-width: 1300px', false);
	const panorama = $derived(wideScreen.current && !narrow);

	let root = $state<HTMLElement>();
	let titleRow = $state<HTMLElement>();
	let facetRow = $state<HTMLElement>();
	let switched = $state(false);
	/** Which side the facet that just came in comes from: -1 for one before the facet it replaces, else 1. */
	let slideFrom = $state(1);

	const activeIndex = () => facets.findIndex((facet) => facet.id === active);
	const roundTheEnd = (index: number) => ((index % facets.length) + facets.length) % facets.length;

	function select(facet: Facet) {
		if (facet.id === active) return;
		switched = true;
		slideFrom = facets.indexOf(facet) < activeIndex() ? -1 : 1;
		active = facet.id;
		onchange?.(facet.id);
	}

	/** Moves `steps` facets on, round the end; focus inside the pivot follows to the new tab, as in a tab list. */
	async function go(steps: number) {
		const next = facets[roundTheEnd(activeIndex() + steps)];
		const focusInside = root?.contains(document.activeElement);
		select(next);
		if (!focusInside || panorama) return;
		await tick();
		document.getElementById(tabId(next))?.focus({ preventScroll: true });
	}

	const arrowSteps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

	function onTabKey(event: KeyboardEvent) {
		const steps = arrowSteps[event.key];
		if (!steps) return;
		event.preventDefault();
		void go(steps);
	}

	function revealActiveFacet(jump: boolean) {
		if (!facetRow) return;
		const facet = facetRow.children[activeIndex()] as HTMLElement | undefined;
		const first = facetRow.firstElementChild as HTMLElement;
		const left = facet ? facet.offsetLeft - first.offsetLeft : 0;
		glidePivot(facetRow, left, jump);
	}

	function reveal(jump: boolean) {
		if (titleRow)
			revealActiveTitle(titleRow, titleRow.querySelector('[aria-selected="true"]'), jump);
		if (panorama) revealActiveFacet(jump);
	}

	let placed = false;
	$effect(() => {
		void active;
		untrack(() => reveal(!placed));
		placed = true;
	});
	$effect(() => bindKeys({ side: (count, key) => void go(key === 'l' ? count : -count) }));
	// Barlow arrives after the first layout (font-display: swap) and changes every width
	onMount(() => void document.fonts?.ready.then(() => reveal(true)));
</script>

<svelte:window onresize={() => reveal(true)} />

{#snippet counter(facet: Facet)}
	{#if facet.count !== undefined}<span class="count">{facet.count}</span>{/if}
{/snippet}

<div class="pivot" class:narrow bind:this={root}>
	<div class="titles" role="tablist" aria-label={label} bind:this={titleRow} data-title-row>
		{#each facets as facet (facet.id)}
			{@const selected = facet.id === active}
			<button
				type="button"
				role="tab"
				id={tabId(facet)}
				aria-selected={selected}
				aria-controls={panelId(facet)}
				tabindex={selected ? 0 : -1}
				onclick={() => select(facet)}
				onkeydown={onTabKey}
			>
				{facet.label}
				{@render counter(facet)}
			</button>
		{/each}
	</div>
	<div
		class="facets"
		data-panorama
		class:switched
		style:--slide-from={slideFrom}
		bind:this={facetRow}
		use:sideways
	>
		{#each facets as facet (facet.id)}
			<!-- a facet may scroll by itself and hold nothing focusable, so keyboards reach it directly -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<section
				id={panelId(facet)}
				role={panorama ? undefined : 'tabpanel'}
				aria-labelledby={panorama ? headingId(facet) : tabId(facet)}
				hidden={!panorama && facet.id !== active}
				tabindex="0"
				style:--facet-width={facet.width}
			>
				<h2 id={headingId(facet)}>{facet.label} {@render counter(facet)}</h2>
				{@render panel(facet)}
			</section>
		{/each}
	</div>
</div>

<style>
	/* Its own width never depends on the panorama inside, which scrolls instead of widening the page */
	.pivot {
		contain: inline-size;
	}
	.titles {
		display: flex;
		align-items: flex-end;
		gap: var(--space-6);
		height: calc(1.25em + var(--space-1));
		margin-inline: calc(-1 * var(--gutter));
		padding: 0 var(--gutter) var(--space-1);
		overflow: auto hidden;
		scrollbar-width: none;
		font-size: var(--type-pivot-active);
		white-space: nowrap;
	}
	.titles::-webkit-scrollbar {
		display: none;
	}
	/* The scaled title grows by transform, which the scroll range only learns of once the transition has run; this makes
	   the room real at once, so a jump (resize, fonts) can reach the end */
	.titles::after {
		content: '';
		flex: none;
		margin-left: calc(var(--active-room, 0px) - var(--space-6));
	}
	[role='tab'] {
		flex: none;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--type-pivot);
		font-weight: var(--weight-light);
		line-height: 1.2;
		text-transform: lowercase;
		cursor: pointer;
		transform-origin: left bottom;
		transition:
			scale var(--motion-short) var(--ease-inout),
			translate var(--motion-short) var(--ease-inout);
	}
	[role='tab']:hover {
		color: var(--text);
	}
	[role='tab'][aria-selected='true'] {
		scale: var(--active-scale, 1);
		color: var(--text);
	}
	[role='tab'][aria-selected='true'] ~ [role='tab'] {
		translate: var(--active-room, 0) 0;
	}
	/* the title row and the panorama clip, so rings go inside, like a tile's */
	[role='tab']:focus-visible,
	section:focus-visible {
		outline-offset: -2px;
		box-shadow: none;
	}
	.count {
		font-size: var(--type-label);
		font-weight: var(--weight-medium);
		vertical-align: super;
	}
	section {
		padding-top: var(--space-3);
	}
	/* a tab names the facet, but the heading keeps the outline whole for readers; visually hidden like .visually-hidden */
	h2 {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.switched > section {
		animation: facet-in calc(var(--motion-moderate) * 0.75) var(--ease-out);
	}
	@keyframes facet-in {
		from {
			opacity: 0;
			translate: calc(var(--motion-slide) * var(--slide-from, 1)) 0;
		}
	}

	@media (min-width: 1300px) {
		.pivot:not(.narrow) .switched > section {
			animation: none;
		}
		.pivot:not(.narrow) .titles {
			display: none;
		}
		.pivot:not(.narrow) .facets {
			display: flex;
			gap: var(--space-8);
			height: var(--stage-h);
			margin-inline: calc(-1 * var(--gutter));
			padding-inline: var(--gutter);
			overflow: auto hidden;
			scrollbar-width: thin;
		}
		/* also shows the facets the server rendered hidden, until hydration lifts `hidden`; Rekta hides every [hidden] with !important */
		.pivot:not(.narrow) .facets section[hidden] {
			display: block !important;
		}
		.pivot:not(.narrow) section {
			display: block;
			flex: 0 0 var(--facet-width, var(--facet-w));
			overflow-y: auto;
		}
		.pivot:not(.narrow) h2 {
			position: static;
			width: auto;
			height: auto;
			margin: 0 0 var(--space-3);
			overflow: visible;
			clip-path: none;
			white-space: normal;
			font-size: var(--type-group);
			font-weight: var(--weight-light);
			text-transform: lowercase;
		}
	}
</style>
