<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * Modaler Dialog auf nativem <dialog> + showModal(): Top-Layer, Hintergrund inert (Fokus bleibt im Dialog),
	 * Escape schließt, Fokus kehrt beim Schließen zum Auslöser zurück. variant="panel" = rechts angedocktes SidePanel.
	 * Anfangsfokus: erstes fokussierbares Element — `autofocus` an einem Feld setzt ihn gezielt.
	 */
	let {
		open = $bindable(false),
		title,
		variant = 'dialog',
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		variant?: 'dialog' | 'panel';
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let el: HTMLDialogElement;
	let downOnBackdrop = false;
	const id = $props.id();

	$effect(() => {
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});
</script>

<!-- Klick auf den Hintergrund schließt; die Tastatur schließt über Escape (natives cancel) bzw. den Schließen-Knopf -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={el}
	class={variant}
	aria-labelledby="{id}-title"
	aria-modal="true"
	onclose={() => (open = false)}
	onpointerdown={(e) => (downOnBackdrop = e.target === el)}
	onclick={(e) => {
		if (downOnBackdrop && e.target === el) open = false;
	}}
>
	<div class="frame">
		<header>
			<h2 id="{id}-title">{title}</h2>
			<button class="btn btn-ghost btn-icon" aria-label="Schließen" onclick={() => (open = false)}
				><Icon name="x" /></button
			>
		</header>
		<div class="body">{@render children()}</div>
		{#if footer}<footer>{@render footer()}</footer>{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(520px, calc(100vw - 2 * var(--space-4)));
		max-height: min(80dvh, 720px);
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow-overlay);
		opacity: 0;
		translate: 0 8px;
		transition:
			opacity var(--dur-fast) var(--ease-out),
			translate var(--dur-fast) var(--ease-out),
			overlay var(--dur-fast) allow-discrete,
			display var(--dur-fast) allow-discrete;
	}
	dialog[open] {
		opacity: 1;
		translate: 0 0;
	}
	dialog.panel {
		inset: 0 0 0 auto;
		width: min(560px, 100vw);
		max-width: 100vw;
		height: 100dvh;
		max-height: none;
		margin: 0;
		border-width: 0 0 0 1px;
		border-radius: 0;
		translate: 16px 0;
	}
	dialog.panel[open] {
		translate: 0 0;
	}
	@starting-style {
		dialog[open] {
			opacity: 0;
			translate: 0 8px;
		}
		dialog.panel[open] {
			translate: 16px 0;
		}
	}
	dialog::backdrop {
		background: var(--scrim);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		opacity: 0;
		transition:
			opacity var(--dur-fast) var(--ease-out),
			overlay var(--dur-fast) allow-discrete,
			display var(--dur-fast) allow-discrete;
	}
	dialog[open]::backdrop {
		opacity: 1;
	}
	@starting-style {
		dialog[open]::backdrop {
			opacity: 0;
		}
	}
	.frame {
		display: flex;
		flex-direction: column;
		max-height: inherit;
		height: 100%;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 44px;
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--border);
	}
	h2 {
		flex: 1;
		font-size: var(--text-base);
		overflow-wrap: anywhere; /* lange Titel umbrechen statt abschneiden */
	}
	.body {
		flex: 1;
		overflow: auto;
		padding: var(--space-4);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--border);
	}
</style>
