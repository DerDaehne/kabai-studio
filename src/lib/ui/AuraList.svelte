<script lang="ts" generics="T extends { key: string }">
	import type { Snippet } from 'svelte';
	import { auraOpacity, type Aura } from './aura';

	/**
	 * A vertical list with one aura layer under all of its items, so a glow never covers a neighbouring item.
	 * `aurae` comes from assignAurae() over everything visible in the view, which keeps the budget view-wide.
	 */
	let { items, aurae, item, label }: { items: T[]; aurae: ReadonlyMap<string, Aura>; item: Snippet<[T]>; label: string } = $props();
</script>

<ul class="aura-list" aria-label={label}>
	<!-- Every row keeps its glow element, so appearing, fading and changing colour are plain CSS transitions -->
	{#each items as entry, row (entry.key)}
		{@const aura = aurae.get(entry.key)}
		<li
			class="glow"
			aria-hidden="true"
			data-strength={aura?.strength}
			style:grid-row="{row + 1} / span 1"
			style:opacity={aura ? auraOpacity[aura.strength] : 0}
			style:background-color={aura?.color}
		></li>
	{/each}
	{#each items as entry (entry.key)}
		<li>{@render item(entry)}</li>
	{/each}
</ul>

<style>
	.aura-list {
		position: relative;
		isolation: isolate;
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		/* Glows may shine past the list edge but never cause page scrolling */
		overflow: clip;
		overflow-clip-margin: 28px;
	}
	/* Out of flow, so it shares the grid row of its item without taking part in auto-placement.
	   The row needs an explicit span: for an out-of-flow child an auto end line is the container edge. */
	.glow {
		position: absolute;
		z-index: -1;
		inset: 28% -14px auto;
		height: 86%;
		border-radius: 40px;
		filter: blur(28px);
		pointer-events: none;
		transition:
			opacity var(--dur-slow) var(--ease-out),
			background-color var(--dur-slow) var(--ease-out);
	}
	@media (max-width: 719px) {
		.aura-list {
			overflow-clip-margin: 12px;
		}
	}
</style>
