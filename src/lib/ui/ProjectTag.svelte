<script lang="ts" module>
	/** Slot in the project palette (--project-1 … --project-5). */
	export type ProjectPalette = 1 | 2 | 3 | 4 | 5;
</script>

<script lang="ts">
	// The letters carry the meaning, the colour only helps telling projects apart at a glance
	let { code, palette }: { code: string; palette: ProjectPalette } = $props();
</script>

<span
	class="tag"
	style:color="var(--project-{palette})"
	style:background-color="var(--project-{palette}-fill)">{code}</span
>

<style>
	.tag {
		display: inline-block;
		padding: 1px 5px;
		border-radius: 5px;
		font: 700 12px / 1.35 var(--font-mono);
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
</style>
