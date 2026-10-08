<script lang="ts" module>
	const numbers = new Intl.NumberFormat('de-DE');
	const percent = new Intl.NumberFormat('de-DE', { style: 'percent' });
</script>

<script lang="ts">
	import { markColor, type Tone } from './tone';

	/** A thin native progress bar that always states its value in words: "x von y" or a percentage. */
	let {
		value,
		max,
		label,
		format = 'count',
		tone = 'neutral'
	}: {
		value: number;
		max: number;
		label: string;
		format?: 'count' | 'percent';
		tone?: Tone;
	} = $props();

	const share = $derived(max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0);
	const text = $derived(
		format === 'percent'
			? percent.format(share)
			: `${numbers.format(value)} von ${numbers.format(max)}`
	);
</script>

<span class="progress" style:--bar={markColor(tone)}>
	<!-- The bar below announces the same label and value, so the caption is for the eye only -->
	<span class="caption" aria-hidden="true">
		<span class="label">{label}</span>
		<span class="figure">{text}</span>
	</span>
	<progress value={share} max="1" aria-label={label} aria-valuetext={text}>{text}</progress>
</span>

<style>
	.progress {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.caption {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--type-label);
	}
	.label {
		color: var(--text-muted);
	}
	.figure {
		font-variant-numeric: tabular-nums;
	}
	progress {
		appearance: none;
		display: block;
		width: 100%;
		height: 4px;
		border: 0;
		background: color-mix(in srgb, currentColor 22%, transparent);
	}
	progress::-webkit-progress-bar {
		background: color-mix(in srgb, currentColor 22%, transparent);
	}
	progress::-webkit-progress-value {
		background: var(--bar);
	}
	progress::-moz-progress-bar {
		background: var(--bar);
	}
</style>
