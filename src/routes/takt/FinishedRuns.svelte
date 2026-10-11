<script lang="ts">
	import { t } from '$lib/i18n/t';
	import type { MessageKey } from '$lib/i18n';
	import type { FinishedRunWithWayOut } from '$lib/server/start-view';
	import { clock, firstLine } from '$lib/trace/trace';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import { runHref } from '../start';

	let { runs }: { runs: FinishedRunWithWayOut[] } = $props();

	const toneOf = (state: string) =>
		state === 'failed' ? 'error' : state === 'succeeded' ? 'success' : 'neutral';
	const duration = (run: FinishedRunWithWayOut) =>
		run.startedAt
			? clock(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)))
			: '–';
</script>

{#if runs.length}
	<ul class="rows" data-testid="finished-runs">
		{#each runs as run (run.id)}
			<li class="row">
				<span class="head">
					<ProjectTag code={run.project.code} palette={run.project.palette} />
					<a href={runHref(run.project.code, run.number, run.id)}>{run.ticket}</a>
					<Tag tone={toneOf(run.state)}>{t(`start.state.${run.state}` as MessageKey)}</Tag>
				</span>
				<span class="detail">{duration(run)}</span>
				{#if run.summary}<span class="detail">{run.summary}</span>{/if}
				{#if run.failure?.wayOut}
					<span class="detail"
						>{t('start.ops.wayOut', { text: firstLine(run.failure.wayOut) })}</span
					>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<p class="detail">{t('takt.finished.empty')}</p>
{/if}

<style>
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--rule);
		overflow-wrap: anywhere;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.detail {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
</style>
