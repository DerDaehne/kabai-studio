<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { focusKeys } from './focus';
	import KeyHints from './KeyHints.svelte';
	import { anyLetter, contextLabels, keymap, validKeys, type KeyContext } from './keys';
	import { live } from './live.svelte';
	import { boundActions, keyboard, setSingleKeys } from './router.svelte';

	/** `context`: the view the overview was opened in; its bound keys come first. */
	let { open = $bindable(false), context }: { open?: boolean; context: KeyContext } = $props();

	const groups = Object.entries(Object.groupBy(Object.values(keymap), (binding) => binding.group));
	const valid = $derived(validKeys(context, '', boundActions()).hints);
</script>

<Dialog bind:open variant="sheet" title="Alle Tasten">
	<section aria-label="Hier gültig">
		<h3>hier gültig · {contextLabels[context]}</h3>
		<KeyHints hints={valid} label="Gültige Tasten" />
	</section>
	<label class="single-keys">
		<input
			type="checkbox"
			checked={keyboard.singleKeys}
			onchange={(event) => setSingleKeys(event.currentTarget.checked)}
		/>
		<span>
			Einzeltasten
			<span class="muted"
				>Aus: jede Taste nur mit Alt, etwa <Kbd key="Alt" /><Kbd key="j" />. Hilft bei
				Spracheingabe.</span
			>
		</span>
	</label>
	{#each groups as [title, bindings = []] (title)}
		<section aria-label={title}>
			<h3>{title}</h3>
			<dl>
				{#each bindings as binding (binding.label)}
					{#if binding.keys[0]?.includes(anyLetter)}
						{#each focusKeys(live.projects) as { letter, project } (project.id)}
							<div>
								<dt>
									{#each binding.keys[0] as key, position (position)}
										<Kbd key={key === anyLetter ? letter : key} />
									{/each}
								</dt>
								<dd>Fokus auf {project.name}</dd>
							</div>
						{/each}
					{:else}
						<div>
							<dt>
								{#each binding.keys as sequence, index (index)}
									{#if index > 0}<span class="or">/</span>{/if}
									{#each sequence as key, position (position)}<Kbd {key} />{/each}
								{/each}
							</dt>
							<dd>{binding.label}</dd>
						</div>
					{/if}
				{/each}
			</dl>
		</section>
	{/each}
	<p class="muted">
		Ziffern davor zählen, etwa <Kbd key="3" /><Kbd key="j" />. Ist eine Entscheidung im Fokus,
		antworten <Kbd key="1" />–<Kbd key="3" /> und Zähler ruhen. <Kbd key="Escape" /> bricht zuerst Zähler
		und Präfix ab. <Kbd key="f" /> ist frei.
	</p>
</Dialog>

<style>
	.single-keys {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.single-keys .muted {
		display: block;
		font-size: var(--text-sm);
	}
	h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	dl {
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: var(--space-1) var(--space-4);
		margin: 0;
	}
	dl div {
		display: contents;
	}
	dt {
		display: flex;
		align-items: center;
		gap: 3px;
	}
	dd {
		margin: 0;
	}
	.or {
		color: var(--text-muted);
	}
	p {
		margin-top: var(--space-4);
		font-size: var(--text-sm);
	}
</style>
