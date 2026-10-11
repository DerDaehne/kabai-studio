<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/t';
	import type { MessageKey } from '$lib/i18n';
	import type { LiveEvent, LiveRun } from '$lib/live';
	import type { RunTrack } from '$lib/server/start-view';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { advanceSeries, type SeriesPoint } from '$lib/trace/step-series';
	import {
		buildTrace,
		firstLine,
		liveTraceEvent,
		withLiveEvent,
		type Phase,
		type TraceStep
	} from '$lib/trace/trace';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Sparkline from '$lib/ui/rekta/Sparkline.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import { runHref } from '../start';

	let { runs, tracks }: { runs: LiveRun[]; tracks: RunTrack[] } = $props();

	// Live trace events and phases fold into the loaded tracks until the next reload replaces them.
	let events = $derived(Object.fromEntries(tracks.map((track) => [track.id, track.events])));
	let series = $derived(Object.fromEntries(tracks.map((track) => [track.id, track.series])));
	const phases: Record<number, Phase> = $state({});

	const PHASES = new Set([
		'thinking',
		'writing',
		'tool',
		'compacting',
		'model_loading',
		'model_downloading'
	]);

	const phaseWord = (runId: number) => {
		const name = phases[runId]?.name;
		return name && PHASES.has(name)
			? t(`start.phase.${name}` as MessageKey)
			: t('start.phase.unknown');
	};

	function tickerLine(runId: number): string {
		const step = buildTrace(events[runId] ?? [])
			.items.flatMap((item) => (item.kind === 'step' ? [item.step] : []))
			.at(-1);
		return step ? stepLine(step) : t('start.trace.noSteps');
	}

	function stepLine(step: TraceStep): string {
		const call = step.calls.at(-1);
		if (!call)
			return step.message
				? firstLine(step.message)
				: t('start.trace.step', { number: step.number });
		const result = call.result?.isError ? t('start.trace.error') : call.result?.summary;
		return [call.tool, call.target, result].filter(Boolean).join(' · ');
	}

	const tokensOf = (points: SeriesPoint[]) =>
		points.map((point) => (point.tokensIn ?? 0) + (point.tokensOut ?? 0));

	function follow(event: LiveEvent) {
		const runId = event.runId as number;
		if (event.type === 'run.phase') phases[runId] = event as unknown as Phase;
		if (event.type !== 'run.event' || !events[runId]) return;
		const traced = liveTraceEvent(event);
		const next = withLiveEvent(events[runId], traced);
		if (!next) return void invalidateLive();
		events = { ...events, [runId]: next };
		series = { ...series, [runId]: advanceSeries({ runId, points: series[runId] }, traced).points };
	}

	onMount(() => onLiveEvent(follow));
</script>

{#if runs.length}
	<ul class="rows" data-testid="live-runs">
		{#each runs as run (run.id)}
			{@const tracked = tracks.some((track) => track.id === run.id)}
			<li class="row" data-run={run.id}>
				<span class="head">
					<ProjectTag code={run.project.code} palette={run.project.palette} />
					<a href={runHref(run.project.code, run.ticket.split('-').at(-1) ?? '', run.id)}
						>{run.ticket}</a
					>
					<Tag tone={run.state === 'waiting' ? 'warning' : 'info'}
						>{t(`start.state.${run.state}` as MessageKey)}</Tag
					>
				</span>
				<span class="detail"
					>{run.profile} · {t(`start.location.${run.location}` as MessageKey)}</span
				>
				{#if tracked}
					<span class="detail">{phaseWord(run.id)}</span>
					<span class="ticker mono">{tickerLine(run.id)}</span>
					<Sparkline
						values={tokensOf(series[run.id] ?? [])}
						label={t('start.tile.tokensPerMinute')}
					/>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<p class="detail">{t('takt.running.empty')}</p>
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
	.ticker {
		font-size: var(--type-meta);
		overflow-wrap: anywhere;
	}
</style>
