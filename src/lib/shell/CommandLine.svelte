<script lang="ts">
	import { parseInput, suggest, type Suggestion, type SuggestionSources } from './commands';

	let {
		sources,
		value = $bindable(''),
		input = $bindable(),
		focused = $bindable(false),
		floating = false,
		autofocus = false,
		onexecute,
		onescape
	}: {
		sources: SuggestionSources;
		value?: string;
		input?: HTMLInputElement;
		focused?: boolean;
		/** Suggestions float above the input (command dock) instead of following it (overlay). */
		floating?: boolean;
		autofocus?: boolean;
		onexecute: (suggestion: Suggestion) => void;
		/** Escape on an empty line; without it the key falls through, e.g. to close a surrounding dialog. */
		onescape?: () => void;
	} = $props();

	const id = $props.id();
	let active = $state(0);
	const parsed = $derived(parseInput(value));
	const suggestions = $derived(parsed.mode ? suggest(parsed.mode, parsed.query, sources) : []);
	const expanded = $derived(focused && suggestions.length > 0);
	const optionId = (index: number) => `${id}-option-${index}`;

	function execute(suggestion: Suggestion | undefined) {
		if (!suggestion || suggestion.available === false) return;
		value = '';
		onexecute(suggestion);
	}

	function onkeydown(event: KeyboardEvent) {
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (step && suggestions.length) {
			event.preventDefault();
			active = (active + step + suggestions.length) % suggestions.length;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			execute(suggestions[active]);
		} else if (event.key === 'Escape' && value) {
			event.preventDefault();
			value = '';
		} else if (event.key === 'Escape' && onescape) {
			event.preventDefault();
			onescape();
		}
	}
</script>

<div class="commandline" class:floating>
	<label class="field">
		<span class="prompt" aria-hidden="true">›</span>
		<span class="visually-hidden">Befehlszeile</span>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			bind:this={input}
			{autofocus}
			bind:value
			type="text"
			role="combobox"
			autocomplete="off"
			spellcheck="false"
			placeholder="Befehl : oder Suche /"
			aria-autocomplete="list"
			aria-controls="{id}-listbox"
			aria-expanded={expanded}
			aria-activedescendant={expanded ? optionId(active) : undefined}
			oninput={() => (active = 0)}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
			{onkeydown}
		/>
	</label>
	<ul id="{id}-listbox" class="suggestions" role="listbox" aria-label="Vorschläge" hidden={!expanded}>
		{#each suggestions as suggestion, index (suggestion.id)}
			<!-- Pointer selection keeps the focus in the input; the keyboard path is ↑↓ ↵ on the combobox -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				id={optionId(index)}
				role="option"
				aria-selected={index === active}
				aria-disabled={suggestion.available === false}
				onpointerdown={(event) => event.preventDefault()}
				onclick={() => execute(suggestion)}
			>
				<span class="label">{suggestion.label}</span>
				{#if suggestion.detail}<span class="detail">{suggestion.detail}</span>{/if}
				{#if suggestion.available === false}<span class="later">folgt</span>{/if}
			</li>
		{/each}
	</ul>
	{#if focused && parsed.mode && parsed.query && !suggestions.length}
		<p class="empty" role="status">Keine Treffer für „{parsed.query}“</p>
	{/if}
</div>

<style>
	.commandline {
		position: relative;
		min-width: 0;
	}
	.field {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: var(--control-h);
		padding: 0 var(--space-2);
		border: 1px solid var(--border-control);
		border-radius: 10px;
		background: var(--surface);
	}
	.field:focus-within {
		border-color: var(--focus);
	}
	.prompt {
		width: 1ch;
		color: var(--accent-text);
		font: 650 var(--text-sm) / 1 var(--font-mono);
	}
	input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	input:focus-visible {
		outline: none;
		box-shadow: none;
	}
	.suggestions,
	.empty {
		margin: var(--space-2) 0 0;
		padding: var(--space-1);
		border-radius: var(--radius-lg);
		background: var(--glass-overlay);
		backdrop-filter: blur(var(--blur-float)) saturate(var(--glass-sat));
		box-shadow: var(--shadow-float);
		list-style: none;
	}
	.floating .suggestions,
	.floating .empty {
		position: absolute;
		bottom: calc(100% + var(--space-3));
		left: 0;
		z-index: 20;
		width: min(520px, calc(100vw - 2 * var(--space-4)));
		margin: 0;
		/* the dock is a backdrop root, so a nested backdrop-filter would only blur the dock itself */
		background: var(--surface-raised);
		backdrop-filter: none;
	}
	.suggestions[hidden] {
		display: none;
	}
	.empty {
		padding: var(--space-2) var(--space-3);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	li {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		min-height: var(--control-h);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius);
		cursor: pointer;
	}
	li[aria-selected='true'] {
		background: var(--fill-sel);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	li[aria-disabled='true'] {
		cursor: default;
	}
	.label {
		font: 600 var(--text-sm) / 1.43 var(--font-mono);
		white-space: nowrap;
	}
	.detail,
	.later {
		min-width: 0;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.later {
		margin-left: auto;
		flex-shrink: 0;
	}
</style>
