<script lang="ts">
	import Kbd from '$lib/ui/Kbd.svelte';
	import { focusKeys } from './focus';
	import { anyLetter, type KeyHint } from './keys';
	import { live } from './live.svelte';

	/** Keys with what they do; the placeholder for any letter becomes the real letter of each project. */
	let { hints, label }: { hints: KeyHint[]; label: string } = $props();
</script>

<ul class="hints" aria-label={label}>
	{#each hints as hint (hint.label)}
		<li>
			{#if hint.keys[0]?.includes(anyLetter)}
				<Kbd key={hint.keys[0][0]} />
				{#each focusKeys(live.projects) as { letter } (letter)}<Kbd key={letter} />{/each}
			{:else}
				{#each hint.keys as sequence, index (index)}
					{#each sequence as key, position (position)}<Kbd {key} />{/each}
				{/each}
			{/if}
			<span>{hint.label}</span>
		</li>
	{/each}
</ul>

<style>
	.hints {
		/* contains the hidden key names of Kbd (position: absolute) */
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--type-meta);
	}
	li {
		display: flex;
		align-items: center;
		gap: 3px;
	}
	span {
		margin-left: 3px;
		color: var(--text-muted);
	}
</style>
