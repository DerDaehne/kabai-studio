<script lang="ts">
	import { onLiveEvent } from '$lib/shell/live.svelte';
	import Badge, { type Tone } from '$lib/ui/Badge.svelte';
	import { travel } from '$lib/ui/motion';
	import TraceStep from './TraceStep.svelte';
	import {
		buildTrace,
		interventionLabel,
		liveTraceEvent,
		tickerText,
		withLiveEvent,
		type Phase,
		type RunTrace,
		type RunTraceState,
		type TraceEvent
	} from './trace';

	/** `trace`: the selected run as loaded; `reload` loads it again once live events were missed. */
	let { trace, reload }: { trace: RunTrace; reload: () => void } = $props();

	const STATES: Record<RunTraceState, { tone: Tone; label: string }> = {
		queued: { tone: 'neutral', label: 'wartet auf Start' },
		running: { tone: 'running', label: 'läuft' },
		waiting_approval: { tone: 'waiting', label: 'wartet auf Freigabe' },
		paused: { tone: 'paused', label: 'pausiert' },
		succeeded: { tone: 'succeeded', label: 'fertig' },
		failed: { tone: 'failed', label: 'fehlgeschlagen' },
		cancelled: { tone: 'neutral', label: 'gestoppt' }
	};

	let events = $derived(trace.events);
	let phase = $state<Phase>();
	const view = $derived(buildTrace(events));
	const runState = $derived(STATES[trace.state]);

	$effect(() =>
		onLiveEvent((event) => {
			if (event.runId !== trace.id) return;
			if (event.type === 'run.phase') phase = event as unknown as Phase;
			if (event.type === 'run.event') receive(liveTraceEvent(event));
		})
	);

	function receive(event: TraceEvent) {
		const next = withLiveEvent(events, event);
		if (next) events = next;
		else reload();
	}
</script>

<div class="head">
	<h3>Run {trace.id}</h3>
	<Badge tone={runState.tone}>{runState.label}</Badge>
</div>
<!-- phases are transient: until the first one arrives (also after a reload) the badge alone says „läuft“ -->
{#if trace.state === 'running' && phase}
	<p class="ticker">{tickerText(phase, view.loadingHint)}</p>
{/if}

{#if view.items.length}
	<ol class="items">
		{#each view.items as item (item.seq)}
			<li in:travel>
				{#if item.kind === 'step'}
					<TraceStep step={item.step} />
				{:else if item.kind === 'intervention'}
					<div class="notice">
						<p>
							<Badge tone="waiting">Eingriff: {interventionLabel(item.intervention.kind)}</Badge>
							fortgesetzt {item.intervention.attempt}/{item.intervention.max}
						</p>
						<p>{item.intervention.reason}</p>
						<p class="muted">Hinweis an den Agent: {item.intervention.hint}</p>
					</div>
				{:else}
					<p class="notice">{item.text} <span class="muted">{item.hint}</span></p>
				{/if}
			</li>
		{/each}
	</ol>
{:else}
	<p class="muted">Noch keine Schritte.</p>
{/if}

{#if trace.failure}
	<div class="failure">
		<p><code class="mono">{trace.failure.code}</code> {trace.failure.message}</p>
		{#if trace.failure.wayOut}<p>Ausweg: {trace.failure.wayOut}</p>{/if}
	</div>
{/if}
{#if view.report}
	<section class="report" aria-labelledby="report-{trace.id}">
		<h4 id="report-{trace.id}">
			{trace.state === 'succeeded' ? 'Abschlussbericht' : 'Übergabe'}
			{#if view.report.generated}<Badge>erzeugt</Badge>{/if}
		</h4>
		<p>{view.report.text}</p>
	</section>
{/if}
{#if trace.state === 'paused' && trace.continuedBy}
	<p><a href="?run={trace.continuedBy}">setzt fort in Run {trace.continuedBy}</a></p>
{:else if trace.state === 'paused' && trace.waitsForAnswer}
	<p><a href="/takt">wartet auf deine Antwort → Takt</a></p>
{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	h3,
	h4,
	p {
		margin: 0;
	}
	.ticker {
		margin-top: var(--space-1);
		color: var(--status-running);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.items {
		display: grid;
		gap: var(--space-3);
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
	}
	.notice {
		display: grid;
		gap: var(--space-1);
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--text-muted);
	}
	.failure,
	.report {
		display: grid;
		gap: var(--space-1);
		margin-top: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}
	.failure {
		background: var(--status-failed-tint);
		color: var(--status-failed);
	}
	.report {
		background: var(--accent-tint);
	}
	.report h4 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--accent-text);
	}
	.report p {
		white-space: pre-wrap;
	}
</style>
