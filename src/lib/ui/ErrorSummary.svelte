<script lang="ts" module>
	/** One refused field: `name` is the control's `name` attribute, which the link focuses. */
	export type FieldError = { name: string; label: string; message: string };
</script>

<script lang="ts">
	import { t } from '$lib/i18n/t';

	/**
	 * The sentence on top of a form that was sent with errors, with a link to each field. It takes focus whenever
	 * `errors` or `message` is replaced, so it is read at once. `message` is a refusal of the whole form (no field).
	 */
	let { errors = [], message }: { errors?: FieldError[]; message?: string } = $props();

	const id = $props.id();
	let summary: HTMLDivElement | undefined = $state();
	const heading = $derived(
		message ??
			(errors.length === 1 ? t('form.errors.one') : t('form.errors.many', { count: errors.length }))
	);

	$effect(() => {
		void errors;
		void message;
		summary?.focus();
	});

	function focusField(event: MouseEvent, name: string) {
		event.preventDefault();
		const scope = summary?.closest('form') ?? document;
		scope.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)?.focus();
	}
</script>

{#if errors.length || message}
	<div
		bind:this={summary}
		class="rk-errors"
		role="group"
		tabindex="-1"
		aria-labelledby="{id}-heading"
	>
		<p id="{id}-heading">{heading}</p>
		{#if errors.length}
			<ul>
				{#each errors as error (error.name)}
					<li>
						<a href="#{error.name}" onclick={(event) => focusField(event, error.name)}
							>{error.label}: {error.message}</a
						>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
