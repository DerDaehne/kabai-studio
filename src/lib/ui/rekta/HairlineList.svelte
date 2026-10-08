<script lang="ts" generics="T extends { key: string }">
	import type { Snippet } from 'svelte';

	/** Rows straight on the ground, divided by hairlines: a list without cards. */
	let { items, row, label }: { items: T[]; row: Snippet<[T]>; label: string } = $props();
</script>

<ul class="hairline-list" aria-label={label}>
	{#each items as item (item.key)}
		<li>{@render row(item)}</li>
	{/each}
</ul>

<style>
	.hairline-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		padding-block: 10px;
		border-block-end: 1px solid var(--rule);
	}
</style>
