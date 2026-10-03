<script lang="ts">
	// label = '' → purely decorative (e.g. inside a button that carries aria-busy itself)
	let { label = 'Lädt …', size = 16 }: { label?: string; size?: number } = $props();
</script>

<span
	class="spinner"
	style:--size="{size}px"
	role={label ? 'status' : undefined}
	aria-hidden={label ? undefined : 'true'}
>
	{#if label}<span class="visually-hidden">{label}</span>{/if}
</span>

<style>
	.spinner {
		display: inline-block;
		flex: none;
		width: var(--size);
		height: var(--size);
		border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
		border-top-color: currentColor;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	/* Reduced motion: spin slower instead of stopping — a still ring would not look like loading */
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s !important;
			animation-iteration-count: infinite !important;
		}
	}
	:global(:root[data-motion='reduced']) .spinner {
		animation-duration: 2.4s !important;
		animation-iteration-count: infinite !important;
	}
</style>
