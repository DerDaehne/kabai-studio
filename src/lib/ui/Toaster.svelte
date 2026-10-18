<script lang="ts">
	import { connection } from '$lib/shell/connection.svelte';
	import { connectionLost, dismiss, hold, runAction, toasts, type Toast } from './toast.svelte';

	let region: HTMLElement;

	// The region is a permanently open manual popover (top layer; the live region exists before the first message).
	// It is reopened on every change so that it also lies above a modal dialog opened later.
	$effect(() => {
		void toasts.length;
		if (region.matches(':popover-open')) region.hidePopover();
		region.showPopover();
	});

	$effect(() => {
		if (connection.lost) connectionLost();
	});

	const seconds = (toast: Toast) => Math.ceil(toast.left / 1000);
	const isEditable = (target: EventTarget | null) =>
		target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]');

	function leaveFocusTo(toast: HTMLElement) {
		if (toast.contains(document.activeElement)) document.getElementById('main')?.focus();
	}

	function escapeDismisses(event: KeyboardEvent, toast: Toast) {
		if (event.key !== 'Escape') return;
		leaveFocusTo(event.currentTarget as HTMLElement);
		dismiss(toast.id);
	}

	// Ctrl/Cmd+Z takes back while the window is open; in a text field it stays the field's own undo
	function takeBackWithKeys(event: KeyboardEvent) {
		const [open] = toasts;
		if (!open?.action?.countdown || event.shiftKey || event.key.toLowerCase() !== 'z') return;
		if (!(event.ctrlKey || event.metaKey) || isEditable(event.target)) return;
		event.preventDefault();
		runAction(open);
	}
</script>

<svelte:window onkeydown={takeBackWithKeys} />

<div class="rk-toasts" popover="manual" role="status" aria-atomic="false" bind:this={region}>
	{#each toasts as toast (toast.id)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="rk-toast"
			data-tone={toast.tone}
			onkeydown={(event) => escapeDismisses(event, toast)}
			onpointerenter={() => hold('pointer', true)}
			onpointerleave={() => hold('pointer', false)}
			onfocusin={() => hold('focus', true)}
			onfocusout={() => hold('focus', false)}
		>
			<p class="rk-toast-msg">
				{#if toast.tone === 'error'}<span class="rk-toast-sr">Fehler: </span>{/if}<span
					>{toast.message}</span
				>
				{#if toast.action?.countdown}
					<span class="rk-toast-sr"
						>, {Math.ceil(toast.windowMs / 1000)} Sekunden zum Rückgängigmachen</span
					>
				{/if}
			</p>
			{#if toast.action}
				<button
					type="button"
					class="rk-toast-act"
					aria-keyshortcuts={toast.action.countdown ? 'Control+Z Meta+Z' : undefined}
					onclick={() => runAction(toast)}
				>
					{toast.action.label}
					{#if toast.action.countdown}<span class="rk-toast-count" aria-hidden="true"
							>{seconds(toast)}</span
						>{/if}
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	/* A popover brings margin, size, border, background and clipping of its own; the Rekta region wants none of them */
	.rk-toasts {
		width: auto;
		height: auto;
		margin: 0;
		border: 0;
		background: transparent;
		color: inherit;
		overflow: visible;
	}
</style>
