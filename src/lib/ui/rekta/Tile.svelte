<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Tone } from './tone';

	/**
	 * A live tile: its whole fill is the state, its size the importance. A link with `href`, a button with
	 * `onclick`, otherwise a plain container for tiles that hold their own controls.
	 */
	let {
		tone = 'neutral',
		size = '1x1',
		href,
		onclick,
		children
	}: {
		tone?: Tone;
		size?: '1x1' | '2x1' | '2x2';
		href?: string;
		onclick?: () => void;
		children: Snippet;
	} = $props();

	const tile = $derived({
		class: 'tile',
		'data-tone': tone,
		'data-size': size,
		style: `--tile-fill: var(--tile-${tone})`
	});
</script>

{#if href}
	<a {href} {...tile}>{@render children()}</a>
{:else if onclick}
	<button type="button" {onclick} {...tile}>{@render children()}</button>
{:else}
	<div {...tile}>{@render children()}</div>
{/if}

<style>
	.tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
		padding: 10px var(--space-3);
		border: 0;
		border-radius: var(--radius-tile);
		background: var(--tile-fill);
		color: var(--text);
		font: inherit;
		text-align: start;
		text-decoration: none;
		transition: box-shadow var(--motion-short) var(--ease-base);
	}
	/* On a state fill the muted grey drops below AA, so secondary words take the primary text colour there */
	.tile:not([data-tone='neutral']) {
		--text-muted: var(--text);
	}
	/* A frame instead of a lighter fill: hover must not cost the text its contrast */
	a.tile:hover,
	button.tile:hover {
		box-shadow: inset 0 0 0 1px currentColor;
		cursor: pointer;
	}
	.tile:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: -4px;
		box-shadow: none;
	}
	.tile[data-size='2x1'] {
		grid-column: span 2;
	}
	.tile[data-size='2x2'] {
		grid-column: span 2;
		grid-row: span 2;
	}
</style>
