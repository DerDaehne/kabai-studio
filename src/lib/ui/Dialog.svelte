<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { t } from '$lib/i18n/t';
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';

	/**
	 * A modal dialog on a native <dialog> with showModal(): top layer, inert background (focus stays in the dialog),
	 * Escape closes, and focus returns to the trigger on close. variant="sheet" is Rekta's sheet coming down from the
	 * top, "bar-sheet" a sheet rising above the app bar. Initial focus: the first focusable element — `autofocus` on
	 * a field or on the safe answer sets it explicitly; a sheet that asks to confirm puts the safe answer first.
	 *
	 * A sheet without a `footer` ends in a close action, so touch has a visible way out.
	 *
	 * `dirty` marks unsaved input: Escape, a tap on the shading and the close button then ask to discard first
	 * instead of closing.
	 */
	let {
		open = $bindable(false),
		title,
		variant = 'dialog',
		dirty = false,
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		variant?: 'dialog' | 'sheet' | 'bar-sheet';
		dirty?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let el: HTMLDialogElement;
	let keepEditing: HTMLButtonElement | undefined = $state();
	let downOnBackdrop = false;
	let discarding = $state(false);
	let leavingForSure = false;
	let lastFocusedControl: HTMLElement | undefined;
	const id = $props.id();
	const isSheet = $derived(variant === 'sheet');

	$effect(() => {
		if (open && !el.open) el.showModal();
		else if (!open && el.open) {
			leavingForSure = true;
			el.close();
		}
		if (!open) discarding = false;
	});

	async function askToDiscard() {
		discarding = true;
		await tick();
		keepEditing?.focus();
	}

	function keepOn() {
		discarding = false;
		lastFocusedControl?.focus();
	}

	function requestClose() {
		if (!dirty) open = false;
		else if (!discarding) void askToDiscard();
	}

	function discard() {
		discarding = false;
		open = false;
	}

	function onCancel(event: Event) {
		if (!dirty) return;
		event.preventDefault();
		if (discarding) keepOn();
		else void askToDiscard();
	}

	function onClose() {
		// Chromium lets a cancel be prevented only while a user activation is unconsumed; the next Escape closes
		// regardless: reopen and ask again instead of losing the input
		if (dirty && !leavingForSure) {
			el.showModal();
			void askToDiscard();
			return;
		}
		leavingForSure = false;
		open = el.open;
	}
</script>

<!-- A click on the backdrop closes; the keyboard closes with Escape (native cancel) or the close button -->
<!-- The close event arrives a task after the dialog closed; if it opened again in between, it stays open -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={el}
	class={isSheet ? 'rk-sheet' : variant}
	closedby={dirty ? 'closerequest' : undefined}
	aria-labelledby="{id}-title"
	aria-modal="true"
	oncancel={onCancel}
	onclose={onClose}
	onfocusin={(e) => {
		if (e.target !== el && !discarding && e.target instanceof HTMLElement)
			lastFocusedControl = e.target;
	}}
	onpointerdown={(e) => (downOnBackdrop = e.target === el)}
	onclick={(e) => {
		if (downOnBackdrop && e.target === el) requestClose();
	}}
>
	{#if isSheet}
		<h2 class="rk-group" id="{id}-title">{title}</h2>
		<div>{@render children()}</div>
		{#if discarding}
			{@render discardQuestion()}
		{:else if footer}
			<div class="rk-actions">{@render footer()}</div>
		{:else}
			<div class="rk-actions">
				<Button variant="primary" onclick={requestClose}>{t('dialog.close')}</Button>
			</div>
		{/if}
	{:else}
		<div class="frame">
			<header>
				<h2 id="{id}-title">{title}</h2>
				<button class="rk-btn rk-btn--quiet btn-icon" aria-label="Schließen" onclick={requestClose}
					><Icon name="x" /></button
				>
			</header>
			<div class="body">{@render children()}</div>
			{#if discarding}
				<footer>{@render discardQuestion()}</footer>
			{:else if footer}
				<footer>{@render footer()}</footer>
			{/if}
		</div>
	{/if}
</dialog>

{#snippet discardQuestion()}
	<div class="rk-actions" role="group" aria-label={t('dialog.discard.title')}>
		<strong>{t('dialog.discard.title')}</strong>
		<button bind:this={keepEditing} type="button" class="rk-btn rk-btn--primary" onclick={keepOn}
			>{t('dialog.discard.keep')}</button
		>
		<Button variant="danger" onclick={discard}>{t('dialog.discard.confirm')}</Button>
	</div>
{/snippet}

<style>
	dialog:not(.rk-sheet) {
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
	dialog:not(.rk-sheet)[open] {
		opacity: 1;
		translate: 0 0;
	}
	/* The bar-sheet spans the screen up to a reading width and rests on the app bar */
	dialog.bar-sheet {
		width: min(var(--sheet-max-w), 100vw);
		max-width: 100vw;
		margin: 0 auto;
		inset: auto 0 calc(var(--appbar-h) + env(safe-area-inset-bottom));
		border-width: 1px 0 0;
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		translate: 0 16px;
	}
	dialog.bar-sheet[open] {
		translate: 0 0;
	}
	@starting-style {
		dialog:not(.rk-sheet)[open] {
			opacity: 0;
			translate: 0 8px;
		}
		dialog.bar-sheet[open] {
			translate: 0 16px;
		}
	}
	dialog:not(.rk-sheet)::backdrop {
		background: var(--scrim);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		opacity: 0;
		transition:
			opacity var(--dur-fast) var(--ease-out),
			overlay var(--dur-fast) allow-discrete,
			display var(--dur-fast) allow-discrete;
	}
	dialog:not(.rk-sheet)[open]::backdrop {
		opacity: 1;
	}
	@starting-style {
		dialog:not(.rk-sheet)[open]::backdrop {
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
	header h2 {
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
	.rk-sheet h2 {
		overflow-wrap: anywhere;
	}
</style>
