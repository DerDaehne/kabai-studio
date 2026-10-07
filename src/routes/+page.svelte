<script lang="ts">
	import NoProject from '$lib/components/NoProject.svelte';
	import { openQuestionsLabel, RUN_STATE_LABELS, type LiveRun } from '$lib/shell/live.svelte';
	import { RUN_STATES as FINISHED_STATES } from '$lib/trace/RunTrace.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const projects = $derived(data.live?.projects ?? []);
	const runs = $derived(data.live?.runs ?? []);
	const openQuestions = $derived(data.live?.openQuestions ?? 0);
	const finishedRuns = $derived(data.finishedRuns ?? []);

	// `?run=` pins the Run-Akte to this run: without it, a ticket with a newer run (a retry, a follow-up) would
	// open that one instead, not the run this row is actually about.
	// LiveRun.ticket is a ready-made "KEY-N" string; the project key never contains a hyphen (DB constraint), so the
	// part after it is always the ticket number.
	const activeHref = (run: LiveRun) =>
		`/p/${run.project.code}/t/${run.ticket.split('-').at(-1)}?run=${run.id}`;
	const finishedHref = (run: (typeof finishedRuns)[number]) =>
		`/p/${run.project.code}/t/${run.number}?run=${run.id}`;
</script>

<h1>Stellwerk</h1>

{#if !projects.length}
	<NoProject />
{:else}
	<section aria-labelledby="active-runs">
		<h2 id="active-runs">Aktive Runs</h2>
		{#if runs.length}
			<ul class="runs">
				{#each runs as run (run.id)}
					<li>
						<ProjectTag code={run.project.code} palette={run.project.palette} />
						<a href={activeHref(run)}>{run.ticket}</a>
						<span class="meta">{run.profile}</span>
						<Badge tone={RUN_STATE_LABELS[run.state].tone}
							>{RUN_STATE_LABELS[run.state].label}</Badge
						>
					</li>
				{/each}
			</ul>
		{:else}
			<EmptyState title="Kein Agent arbeitet.">
				Starte einen Run aus dem Board, wenn ein Ticket bereit ist.
				{#snippet action()}<a class="btn btn-primary" href="/board">Zum Board</a>{/snippet}
			</EmptyState>
		{/if}
	</section>

	<section aria-labelledby="open-questions">
		<h2 id="open-questions">Offene Fragen</h2>
		<p><a href="/takt">{openQuestionsLabel(openQuestions)}</a></p>
	</section>

	<section aria-labelledby="finished-runs">
		<h2 id="finished-runs">Zuletzt beendet</h2>
		{#if finishedRuns.length}
			<ul class="runs">
				{#each finishedRuns as run (run.id)}
					<li>
						<ProjectTag code={run.project.code} palette={run.project.palette} />
						<a href={finishedHref(run)}>{run.ticket}</a>
						<Badge tone={FINISHED_STATES[run.state].tone}>{FINISHED_STATES[run.state].label}</Badge>
						{#if run.summary}<span class="meta">{run.summary}</span>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Noch kein beendeter Run.</p>
		{/if}
	</section>
{/if}

<form method="POST" action="/logout">
	Angemeldet als {data.user.name} · <button>Abmelden</button>
</form>

<style>
	h2 {
		margin: var(--space-5) 0 var(--space-2);
		font-size: var(--text-base);
	}
	.runs {
		display: grid;
		gap: var(--space-2);
		max-width: 72ch;
		padding: 0;
		list-style: none;
	}
	.runs li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.meta {
		overflow-wrap: anywhere;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--text-muted);
	}
</style>
