<script lang="ts">
	import Icon from './Icon.svelte';
	import { dismiss, toasts } from './toast.svelte';

	let region: HTMLElement;

	// Die Region ist ein dauerhaft offenes manuelles Popover (Top-Layer, Live-Region existiert vor der ersten Meldung).
	// Bei jeder Änderung neu öffnen, damit sie auch über einem später geöffneten modalen Dialog liegt.
	// ponytail: solange ein modaler Dialog offen ist, kann der Schließen-Knopf inert sein — Fehler-Toasts dann nach dem Dialog schließen.
	$effect(() => {
		void toasts.length;
		if (region.matches(':popover-open')) region.hidePopover();
		region.showPopover();
	});
</script>

<section class="toaster" popover="manual" bind:this={region} aria-label="Benachrichtigungen">
	<div role="status" aria-live="polite" class="list">
		{#each toasts as t (t.id)}
			<div class="toast" data-tone={t.tone}>
				<span class="bar" aria-hidden="true"></span>
				<p>{#if t.tone === 'error'}<span class="visually-hidden">Fehler: </span>{/if}{t.message}
					{#if t.action}<a href={t.action.href}>{t.action.label}</a>{/if}</p>
				<button class="btn btn-ghost btn-icon btn-sm" aria-label="Meldung schließen" onclick={() => dismiss(t.id)}>
					<Icon name="x" size={14} />
				</button>
			</div>
		{/each}
	</div>
</section>

<style>
	.toaster {
		inset: auto var(--space-4) var(--space-4) auto;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		overflow: visible;
		color: var(--text);
	}
	.list {
		display: grid;
		gap: var(--space-2);
		width: min(360px, calc(100vw - 2 * var(--space-4)));
	}
	.toast {
		display: grid;
		grid-template-columns: 3px 1fr auto;
		align-items: start;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-1) var(--space-2) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow-overlay);
		transition:
			opacity var(--dur-fast) var(--ease-out),
			translate var(--dur-fast) var(--ease-out);
	}
	@starting-style {
		.toast {
			opacity: 0;
			translate: 0 6px;
		}
	}
	.toast p {
		padding-block: 2px;
	}
	.bar {
		align-self: stretch;
		border-radius: 2px;
		background: var(--accent);
	}
	.toast[data-tone='info'] .bar {
		background: var(--status-running);
	}
	.toast[data-tone='error'] .bar {
		background: var(--status-failed);
	}
	.toast[data-tone='error'] p {
		color: var(--status-failed);
		font-weight: 560;
	}
	@media (max-width: 719px) {
		.toaster {
			inset: auto var(--space-3) calc(var(--tabbar-h) + env(safe-area-inset-bottom) + var(--space-2)) var(--space-3);
		}
		.list {
			width: auto;
		}
	}
</style>
