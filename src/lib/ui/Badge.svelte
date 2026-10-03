<script lang="ts" module>
	export type Tone =
		'neutral' | 'accent' | 'running' | 'waiting' | 'failed' | 'succeeded' | 'paused';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	// Status immer Farbe + Text; der Punkt markiert Laufzeit-Zustände (running pulsiert).
	let { tone = 'neutral', children }: { tone?: Tone; children: Snippet } = $props();
</script>

<span class="badge" data-tone={tone}>
	{#if tone !== 'neutral' && tone !== 'accent'}<span class="dot" aria-hidden="true"></span>{/if}
	{@render children()}
</span>

<style>
	.badge {
		--fg: var(--status-neutral);
		--tint: var(--status-neutral-tint);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 20px;
		padding: 0 var(--space-2) 0 7px;
		border-radius: var(--radius-sm);
		background: var(--tint);
		color: var(--fg);
		font-size: var(--text-sm);
		font-weight: 560;
		line-height: 1;
		white-space: nowrap;
	}
	.badge[data-tone='neutral'],
	.badge[data-tone='accent'] {
		padding-left: var(--space-2);
	}
	.badge[data-tone='accent'] {
		--fg: var(--accent-text);
		--tint: var(--accent-tint);
	}
	.badge[data-tone='running'] {
		--fg: var(--status-running);
		--tint: var(--status-running-tint);
	}
	.badge[data-tone='waiting'] {
		--fg: var(--status-waiting);
		--tint: var(--status-waiting-tint);
	}
	.badge[data-tone='failed'] {
		--fg: var(--status-failed);
		--tint: var(--status-failed-tint);
	}
	.badge[data-tone='succeeded'] {
		--fg: var(--status-succeeded);
		--tint: var(--status-succeeded-tint);
	}
	.badge[data-tone='paused'] {
		--fg: var(--status-paused);
		--tint: var(--status-paused-tint);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
	.badge[data-tone='paused'] .dot {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px currentColor;
	}
	.badge[data-tone='running'] .dot {
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
</style>
