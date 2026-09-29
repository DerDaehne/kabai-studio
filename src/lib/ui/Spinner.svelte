<script lang="ts">
	// label = '' → rein dekorativ (z. B. im Button, der selbst aria-busy trägt)
	let { label = 'Lädt …', size = 16 }: { label?: string; size?: number } = $props();
</script>

<span class="spinner" style:--size="{size}px" role={label ? 'status' : undefined} aria-hidden={label ? undefined : 'true'}>
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
	/* Reduzierte Bewegung: langsamer drehen statt anhalten — ein stehender Ring sähe nicht nach Laden aus */
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s !important;
			animation-iteration-count: infinite !important;
		}
	}
</style>
