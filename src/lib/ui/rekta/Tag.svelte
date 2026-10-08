<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Tone } from './tone';

	/** A state word behind a square in the full state colour: the word carries the meaning, the colour helps. */
	let { tone = 'neutral', children }: { tone?: Tone; children: Snippet } = $props();
</script>

<span class="tag" data-tone={tone} style:--square="var(--mark-{tone})">{@render children()}</span>

<style>
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--type-label);
		font-weight: var(--weight-medium);
		line-height: 1.5;
		white-space: nowrap;
	}
	.tag::before {
		content: '';
		flex: none;
		width: 8px;
		height: 8px;
		background: var(--square);
	}
</style>
