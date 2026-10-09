<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * A modal dialog on a native <dialog> with showModal(): top layer, inert background (focus stays in the dialog),
	 * Escape closes, and focus returns to the trigger on close. variant="panel" = a side panel docked on the right,
	 * "sheet" = a sheet coming down from the top, "bar-sheet" = a sheet rising above the app bar.
	 * Initial focus: the first focusable element — `autofocus` on a field sets it explicitly.
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
		variant?: 'dialog' | 'panel' | 'sheet' | 'bar-sheet';
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

<!-- A click on the backdrop closes; the keyboard closes with Escape (native cancel) or the close button -->
<!-- The close event arrives a task after the dialog closed; if it opened again in between, it stays open -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={el}
	class={variant}
	aria-labelledby="{id}-title"
	aria-modal="true"
	onclose={() => (open = el.open)}
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
	/* Sheets span the screen up to a reading width and stay clear of the head or rest on the app bar */
	dialog.sheet,
	dialog.bar-sheet {
		width: min(760px, 100vw);
		max-width: 100vw;
		margin: 0 auto;
	}
	dialog.sheet {
		inset: 0 0 auto;
		border-width: 0 0 1px;
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
		translate: 0 -16px;
	}
	dialog.bar-sheet {
		inset: auto 0 calc(var(--appbar-h) + env(safe-area-inset-bottom));
		border-width: 1px 0 0;
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		translate: 0 16px;
	}
	dialog.sheet[open],
	dialog.bar-sheet[open] {
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
		dialog.sheet[open] {
			translate: 0 -16px;
		}
		dialog.bar-sheet[open] {
			translate: 0 16px;
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
