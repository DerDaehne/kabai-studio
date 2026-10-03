<script lang="ts">
	import type { Snippet } from 'svelte';

	// Leere Ansicht = Einladung zu handeln: was fehlt (title), was zu tun ist (children), die Aktion (action).
	let { title, children, action }: { title: string; children?: Snippet; action?: Snippet } =
		$props();
</script>

<div class="empty">
	<p class="title">{title}</p>
	{#if children}<p class="text">{@render children()}</p>{/if}
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: start;
		gap: var(--space-1);
		max-width: 44ch;
		padding: var(--space-6) var(--space-4);
		border: 1px dashed var(--border);
		border-radius: var(--radius-lg);
	}
	.title {
		font-weight: 620;
	}
	.text {
		color: var(--text-muted);
	}
	.action {
		margin-top: var(--space-2);
	}
</style>
