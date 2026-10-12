<script lang="ts">
	import { t } from '$lib/i18n/t';
	import type { Step } from '$lib/server/domain/variants';

	let { steps, label }: { steps: readonly Step[]; label?: string } = $props();
</script>

<ol class="steps" aria-label={label}>
	{#each steps as step (step)}
		<li>{t(`step.${step}`)}</li>
	{/each}
</ol>

<style>
	.steps {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	li + li::before {
		content: '→';
		margin-right: var(--space-2);
	}
</style>
