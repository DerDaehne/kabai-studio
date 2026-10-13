<script lang="ts">
	import { renderAgentText } from '$lib/markdown';

	let { text, breaks = true }: { text: string; breaks?: boolean } = $props();
</script>

<div class="agent-text">{@html renderAgentText(text, { breaks })}</div>

<style>
	.agent-text {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.agent-text > :global(:first-child) {
		margin-top: 0;
	}
	.agent-text > :global(:last-child) {
		margin-bottom: 0;
	}
	.agent-text :global(p),
	.agent-text :global(ul),
	.agent-text :global(ol),
	.agent-text :global(pre),
	.agent-text :global(blockquote) {
		margin: var(--space-2) 0;
	}
	.agent-text :global(ul),
	.agent-text :global(ol) {
		padding-left: var(--space-6);
	}
	.agent-text :global(h4),
	.agent-text :global(h5),
	.agent-text :global(h6) {
		margin: var(--space-3) 0 var(--space-1);
		font-size: var(--type-body);
		font-weight: var(--weight-semibold);
	}
	.agent-text :global(code) {
		font-family: var(--font-mono);
		font-size: var(--type-meta);
	}
	.agent-text :global(pre) {
		padding: var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--surface);
		overflow-x: auto;
	}
	.agent-text :global(blockquote) {
		padding-left: var(--space-3);
		border-left: 2px solid var(--rule);
		color: var(--text-muted);
	}
</style>
