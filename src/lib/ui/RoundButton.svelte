<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';

	/** A command of the app bar: an outlined round glyph with its word beneath; the word is the button's name. */
	let {
		icon,
		word,
		title,
		danger = false,
		onclick
	}: {
		icon: IconName;
		word: string;
		title?: string;
		danger?: boolean;
		onclick: () => void;
	} = $props();
</script>

<button type="button" class="round" class:danger {title} {onclick}>
	<span class="circle"><Icon name={icon} size={18} /></span>
	<span class="word">{word}</span>
</button>

<style>
	.round {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: 48px;
		min-height: 52px;
		padding: 2px var(--space-1);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		transition: background-color var(--motion-short) var(--ease-base);
	}
	.round:hover {
		background: var(--fill-soft);
	}
	.circle {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 1.5px solid currentColor;
		border-radius: 50%;
	}
	.word {
		font-size: var(--type-label);
		line-height: 1.2;
		white-space: nowrap;
	}
	.danger {
		color: var(--status-failed);
	}
</style>
