<script lang="ts" module>
	const numbers = new Intl.NumberFormat('de-DE');
</script>

<script lang="ts">
	/** One figure in tabular digits with its unit, and the short label beneath that names it. */
	let { label, value, unit }: { label: string; value: number | string; unit?: string } = $props();
</script>

<span class="stat">
	<span class="value"
		>{typeof value === 'number' ? numbers.format(value) : value}{#if unit}<span class="unit"
				>&nbsp;{unit}</span
			>{/if}</span
	>
	<span class="label">{label}</span>
</span>

<style>
	.stat {
		display: inline-flex;
		flex-direction: column;
		min-width: 0;
	}
	.value {
		font-size: var(--type-figure);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.unit {
		font-size: var(--type-meta);
	}
	.label {
		color: var(--text-muted);
		font-size: var(--type-label);
		letter-spacing: 0.02em;
	}
</style>
