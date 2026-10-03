<script lang="ts" module>
	/** Attributes the input element must take over: `{#snippet children(a)}<input {...a} />{/snippet}` */
	export type FieldAttrs = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: 'true' };
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		hint,
		error,
		children
	}: { label: string; hint?: string; error?: string; children: Snippet<[FieldAttrs]> } = $props();
	const id = $props.id();
	const describedby = $derived(
		[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id}>{label}</label>
	{@render children({
		id,
		'aria-describedby': describedby,
		'aria-invalid': error ? 'true' : undefined
	})}
	{#if hint}<p id="{id}-hint" class="hint">{hint}</p>{/if}
	{#if error}<p id="{id}-error" class="error">{error}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-1);
	}
	label {
		font-size: var(--text-sm);
		font-weight: 560;
	}
	.hint,
	.error {
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.error {
		color: var(--status-failed);
		font-weight: 560;
	}
</style>
