<script lang="ts" module>
	/** Attributes the input element must take over: `{#snippet children(a)}<input {...a} />{/snippet}` */
	export type FieldAttrs = {
		id: string;
		class: 'rk-input';
		'aria-describedby'?: string;
		'aria-invalid'?: 'true';
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/t';

	let {
		label,
		hint,
		error,
		optional = false,
		children
	}: {
		label: string;
		hint?: string;
		error?: string;
		/** Required fields carry no mark; an optional one says so in its label. */
		optional?: boolean;
		children: Snippet<[FieldAttrs]>;
	} = $props();
	const id = $props.id();
	// the hint turns into the error, in the same place and the same element
	const note = $derived(error ?? hint);
	const noteId = $derived(`${id}-${error ? 'error' : 'hint'}`);
</script>

<div class="rk-field" data-status={error ? 'error' : undefined}>
	<label class="rk-label" for={id}
		>{label}{#if optional}{' '}
			<span class="rk-optional">{t('form.optional')}</span>{/if}</label
	>
	{@render children({
		id,
		class: 'rk-input',
		'aria-describedby': note ? noteId : undefined,
		'aria-invalid': error ? 'true' : undefined
	})}
	{#if note}<p id={noteId} class="rk-hint">{note}</p>{/if}
</div>
