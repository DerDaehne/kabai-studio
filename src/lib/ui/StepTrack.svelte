<script lang="ts">
	import { t } from '$lib/i18n/t';
	import type { Progress } from '$lib/lage';

	/** The dots of a ticket's way through its steps, announced as "step 2 of 4". */
	let { progress }: { progress: Progress } = $props();
</script>

<span class="track" role="img" aria-label={t('board.progress', progress)}>
	{#each { length: progress.total }, step}<span class="dot" class:filled={step < progress.index}
		></span>{/each}
</span>

<style>
	.track {
		display: inline-flex;
		gap: 3px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border: 1px solid currentColor;
		border-radius: 50%;
	}
	.dot.filled {
		background: currentColor;
	}
</style>
