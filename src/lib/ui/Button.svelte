<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
	type Props = HTMLButtonAttributes & {
		variant?: Variant;
		/** Rekta has no small step: `sm` is as high as `md`. */
		size?: 'sm' | 'md';
		/** While an action runs the button stays focusable (aria-disabled instead of disabled) and ignores clicks. */
		loading?: boolean;
	};
	// danger has no class of its own: Rekta's status attribute marks it
	const VARIANT_CLASS: Record<Variant, string | undefined> = {
		primary: 'rk-btn--primary',
		secondary: undefined,
		ghost: 'rk-btn--quiet',
		danger: undefined
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
	class={['rk-btn', VARIANT_CLASS[variant], cls]}
	data-status={variant === 'danger' ? 'error' : undefined}
	data-rk-pending={loading || undefined}
	aria-busy={loading || undefined}
	aria-disabled={loading || rest['aria-disabled'] || undefined}
	onclick={(e) => {
		if (loading) e.preventDefault();
		else onclick?.(e);
	}}
>
	{@render children?.()}
</button>
