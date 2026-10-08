<script lang="ts" module>
	const WIDTH = 100;
	const numbers = new Intl.NumberFormat('de-DE');

	function trend(first: number, last: number): string {
		if (last > first) return 'steigend';
		if (last < first) return 'fallend';
		return 'gleichbleibend';
	}

	/** What is measured, the latest value and the trend in words; the text alternative of the graph. */
	function describe(label: string, values: readonly number[], unit: string): string {
		const last = values.at(-1);
		if (last === undefined) return `${label}: keine Daten`;
		const latest = `${label}: ${numbers.format(last)}${unit ? ` ${unit}` : ''}`;
		return values.length === 1 ? latest : `${latest}, ${trend(values[0], last)}`;
	}

	/** Path points scaled from 0 to the largest value; a single value draws a flat line. */
	function plot(values: readonly number[], height: number): [number, number][] {
		const series = values.length === 1 ? [values[0], values[0]] : values;
		const max = Math.max(...series, 1);
		const step = WIDTH / (series.length - 1);
		const round = (n: number) => Math.round(n * 10) / 10;
		return series.map((value, i) => [
			round(i * step),
			round(height - 2 - (value / max) * (height - 4))
		]);
	}
</script>

<script lang="ts">
	import { markColor, type Tone } from './tone';

	let {
		values,
		label,
		unit = '',
		tone = 'neutral',
		height = 28
	}: {
		values: readonly number[];
		label: string;
		unit?: string;
		tone?: Tone;
		height?: number;
	} = $props();

	const description = $derived(describe(label, values, unit));
	const line = $derived(
		plot(values, height)
			.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`)
			.join(' ')
	);
</script>

{#if values.length === 0}
	<span class="empty">{description}</span>
{:else}
	<svg
		class="sparkline"
		viewBox="0 0 {WIDTH} {height}"
		preserveAspectRatio="none"
		role="img"
		aria-label={description}
		style:height="{height}px"
		style:--stroke={markColor(tone)}
	>
		<title>{description}</title>
		<path class="area" d="{line} L{WIDTH},{height} L0,{height} Z" />
		<path class="line" d={line} vector-effect="non-scaling-stroke" />
	</svg>
{/if}

<style>
	.sparkline {
		display: block;
		width: 100%;
		overflow: visible;
	}
	.area {
		fill: var(--stroke);
		opacity: 0.18;
	}
	.line {
		fill: none;
		stroke: var(--stroke);
		stroke-width: 1.5;
	}
	.empty {
		color: var(--text-muted);
		font-size: var(--type-label);
	}
</style>
