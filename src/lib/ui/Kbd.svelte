<script lang="ts" module>
	const symbols: Record<string, { glyph: string; name: string }> = {
		' ': { glyph: '␣', name: 'Leertaste' },
		Enter: { glyph: '↵', name: 'Eingabe' },
		Escape: { glyph: 'esc', name: 'Escape' },
		Tab: { glyph: '⇥', name: 'Tab' },
		ArrowUp: { glyph: '↑', name: 'Pfeil hoch' },
		ArrowDown: { glyph: '↓', name: 'Pfeil runter' },
		ArrowLeft: { glyph: '←', name: 'Pfeil links' },
		ArrowRight: { glyph: '→', name: 'Pfeil rechts' }
	};
</script>

<script lang="ts">
	/** `key` uses KeyboardEvent.key names; `active` marks a key that is currently pressed or armed. */
	let { key, active = false }: { key: string; active?: boolean } = $props();
	const symbol = $derived(symbols[key]);
</script>

<kbd class:active>
	{#if symbol}<span aria-hidden="true">{symbol.glyph}</span><span class="visually-hidden"
			>{symbol.name}</span
		>{:else}{key}{/if}
</kbd>

<style>
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		border-radius: 6px;
		background: var(--kbd-bg);
		box-shadow:
			0 1.5px 0 var(--kbd-edge),
			0 2px 6px var(--shade-1);
		color: var(--text);
		font: 650 12px / 1 var(--font-mono);
		vertical-align: middle;
		transition:
			background-color var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	kbd.active {
		background: var(--accent);
		box-shadow:
			0 1.5px 0 var(--accent-hover),
			0 0 16px var(--aura-accent);
		color: var(--on-accent);
	}
</style>
