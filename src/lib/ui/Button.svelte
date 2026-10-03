<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Spinner from './Spinner.svelte';

	type Props = HTMLButtonAttributes & {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		/** Läuft eine Aktion: Button bleibt fokussierbar (aria-disabled statt disabled), Klicks werden ignoriert. */
		loading?: boolean;
	};
	let {
		variant = 'secondary',
		size = 'md',
		loading = false,
		type = 'button',
		class: cls,
		onclick,
		children,
		...rest
	}: Props = $props();
</script>

<button
	{...rest}
	{type}
	class={['btn', variant !== 'secondary' && `btn-${variant}`, size === 'sm' && 'btn-sm', cls]}
	aria-busy={loading || undefined}
	aria-disabled={loading || rest['aria-disabled'] || undefined}
	onclick={(e) => {
		if (loading) e.preventDefault();
		else onclick?.(e);
	}}
>
	{#if loading}<Spinner size={size === 'sm' ? 12 : 14} label="" />{/if}
	{@render children?.()}
</button>
