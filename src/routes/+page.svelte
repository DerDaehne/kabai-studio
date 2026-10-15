<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { SvelteSet } from 'svelte/reactivity';
	import NoProject from '$lib/components/NoProject.svelte';
	import { failureOf, postAction } from '$lib/form-action';
	import type { MessageKey } from '$lib/i18n';
	import { t } from '$lib/i18n/t';
	import type { LiveEvent, ProjectRef, QueuedQuestion } from '$lib/live';
	import { inFocus } from '$lib/shell/focus';
	import { invalidateLive, onLiveEvent } from '$lib/shell/live.svelte';
	import { plainText, splitLead } from '$lib/markdown';
	import { bindKeys, readKey } from '$lib/shell/router.svelte';
	import { shell } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import { foldLiveEvent, type SeriesPoint } from '$lib/trace/step-series';
	import {
		buildTrace,
		clock,
		firstLine,
		gist,
		liveTraceEvent,
		phaseName,
		tokenFigure,
		type LivePhase,
		type TraceEvent,
		type TraceStep
	} from '$lib/trace/trace';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import { glideScrollLeft, motionMode, tokenMs } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Sparkline from '$lib/ui/rekta/Sparkline.svelte';
	import StatPair from '$lib/ui/rekta/StatPair.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import Tile from '$lib/ui/rekta/Tile.svelte';
	import { SIDEWAYS_MIN_WIDTH, sideways } from '$lib/ui/sideways';
	import { dismiss, toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';
	import { nowTiles, runHref, type NowTile } from './start';

	let { data }: PageProps = $props();
	/** Marks the node `data-clamped` while its text is cut off by the line clamp. */
	function clamped(node: HTMLElement, _text: string) {
		const mark = () => node.toggleAttribute('data-clamped', node.scrollHeight > node.clientHeight);
		const observer = new ResizeObserver(mark);
		observer.observe(node);
		mark();
		return { update: mark, destroy: () => observer.disconnect() };
	}

	const locale = $derived(page.data.locale);
	const projects = $derived(data.live?.projects ?? []);
	const runs = $derived(data.live?.runs ?? []);
	const answered = new SvelteSet<number>();
	const questions = $derived(data.questions.filter((question) => !answered.has(question.id)));
	const tiles = $derived(nowTiles(questions, runs, data.finished));
	const shownTiles = $derived(tiles.filter((tile) => inFocus(shell.focus, tile.project.id)));
	const hiddenTiles = $derived(tiles.filter((tile) => !inFocus(shell.focus, tile.project.id)));

	// Live trace events fold into the loaded tracks until the next reload replaces them; a live phase stays beside them.
	let events = $derived(Object.fromEntries(data.tracks.map((track) => [track.id, track.events])));
	let series = $derived(Object.fromEntries(data.tracks.map((track) => [track.id, track.series])));
	let tokens = $derived(Object.fromEntries(data.tracks.map((track) => [track.id, track.tokens])));
	let steps = $derived(Object.fromEntries(data.tracks.map((track) => [track.id, track.steps])));
	const phases: Record<number, LivePhase> = $state({});
	// The newest stored event each run was seen with over the stream, also before its track is loaded.
	const seenSeq: Record<number, number> = {};

	let now = $state(Date.now());
	let panorama = $state<HTMLElement>();
	let stopping = $state<number>();
	let stopForm = $state<HTMLFormElement>();

	const numbers = $derived(new Intl.NumberFormat(locale));
	const dollars = $derived(
		new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
	);
	const times = $derived(new Intl.DateTimeFormat(locale, { timeStyle: 'short' }));
	const plural = $derived(new Intl.PluralRules(locale));

	const hiddenLine = $derived.by(() => {
		if (!hiddenTiles.length) return '';
		const others = new Set(hiddenTiles.map((tile) => tile.project.id)).size;
		const key: MessageKey =
			plural.select(others) === 'one' ? 'start.hidden.one' : 'start.hidden.other';
		return t(key, { count: hiddenTiles.length, projects: others });
	});

	const lageLine = $derived(
		runs
			.filter((run) => run.state === 'running' || run.state === 'waiting')
			.map((run) =>
				t('start.lage.run', {
					profile: run.profile,
					location: t(`start.location.${run.location}` as MessageKey),
					project: run.project.name,
					ticket: run.ticket
				})
			)
			.join(' · ')
	);

	const countFor = (projectId: number) => ({
		questions: questions.filter((question) => question.project.id === projectId).length,
		agents: runs.filter(
			(run) => run.project.id === projectId && (run.state === 'running' || run.state === 'waiting')
		).length
	});

	const runnerLine = $derived.by(() => {
		if (data.live?.halt === 'stop') return t('start.ops.runnerStop');
		if (data.live?.halt === 'pause') return t('start.ops.runnerPause');
		const active = data.live?.activeRuns ?? 0;
		return active ? t('start.ops.runnerActive', { count: active }) : t('start.ops.runnerFree');
	});

	const lastSteps = (runId: number): TraceStep[] =>
		buildTrace(events[runId] ?? [])
			.items.flatMap((item) => (item.kind === 'step' ? [item.step] : []))
			.slice(-5);

	function stepLine(step: TraceStep): string {
		const call = step.calls.at(-1);
		if (!call)
			return step.message ? gist(step.message) : t('start.trace.step', { number: step.number });
		const result = call.result?.isError ? t('start.trace.error') : call.result?.summary;
		return [call.tool, call.target, result].filter(Boolean).join(' · ');
	}

	const PHASES = new Set([
		'thinking',
		'writing',
		'tool',
		'compacting',
		'model_loading',
		'model_downloading'
	]);
	const phaseWord = (runId: number) => {
		const name = phaseName(events[runId] ?? [], phases[runId]);
		return t(`start.phase.${PHASES.has(name) ? name : 'working'}` as MessageKey);
	};

	const duration = (from: string | null, to: string | number) =>
		from
			? clock(Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)))
			: '–';

	const costText = (cost: number) => (cost > 0 ? dollars.format(cost) : t('start.today.noCost'));

	const tokensOf = (points: SeriesPoint[]) =>
		points.map((point) => (point.tokensIn ?? 0) + (point.tokensOut ?? 0));

	function follow(event: LiveEvent) {
		const runId = event.runId as number;
		if (event.type === 'run.phase') {
			const afterSeq = Math.max(seenSeq[runId] ?? 0, events[runId]?.at(-1)?.seq ?? 0);
			phases[runId] = { ...(event as unknown as LivePhase), afterSeq };
		}
		if (event.type !== 'run.event') return;
		const traced = liveTraceEvent(event);
		seenSeq[runId] = Math.max(seenSeq[runId] ?? 0, traced.seq);
		if (!events[runId]) return;
		const run = {
			events: events[runId],
			steps: steps[runId],
			tokens: tokens[runId],
			series: series[runId]
		};
		const folded = foldLiveEvent(run, runId, traced);
		if (!folded) return void invalidateLive();
		events = { ...events, [runId]: folded.events };
		steps = { ...steps, [runId]: folded.steps };
		tokens = { ...tokens, [runId]: folded.tokens };
		series = { ...series, [runId]: folded.series };
	}

	onMount(() => onLiveEvent(follow));
	$effect(() => {
		if (!data.tracks.length) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	afterNavigate(() => (stopping = undefined));

	async function send(question: QueuedQuestion, option: number, undo: () => void) {
		answered.add(question.id);
		const fields = { question: String(question.id), option: String(option) };
		const failure = failureOf(await postAction('/takt?/answer', fields));
		if (failure) {
			answered.delete(question.id);
			toast(failure, 'error');
			return undefined;
		}
		const sent = t('start.answer.sent', {
			ref: question.ticket.ref,
			seconds: data.undoWindowMs / 1000
		});
		return toast(sent, 'success', data.undoWindowMs, { label: t('start.answer.undo'), run: undo });
	}

	async function takeBack(question: QueuedQuestion) {
		const failure = failureOf(
			await postAction('/takt?/retract', { question: String(question.id) })
		);
		if (failure) return void toast(failure, 'error');
		answered.delete(question.id);
		await invalidateLive();
	}

	/** One entry on the shared undo stack, so `u`, Ctrl+r and the notice's button take the same way as in the Takt. */
	function answer(question: QueuedQuestion, option: number) {
		if (option > question.options.length) return;
		let notice: number | undefined;
		const action: Undoable = {
			label: t('start.answer.label', { ref: question.ticket.ref }),
			perform: () =>
				void send(question, option, () => undoStack.revert(action)).then((id) => (notice = id)),
			revert: () => {
				if (notice !== undefined) dismiss(notice);
				void takeBack(question);
			}
		};
		undoStack.perform(action);
	}

	const sections = () => [...(panorama?.querySelectorAll<HTMLElement>(':scope > section') ?? [])];
	const focusedItem = () => document.activeElement?.closest<HTMLElement>('[data-item]') ?? null;
	const currentSection = () =>
		document.activeElement?.closest<HTMLElement>('.panorama > section') ?? sections()[0];
	const tileOf = (element: HTMLElement | null) =>
		tiles.find((tile) => tile.key === element?.dataset.item);

	function showSection(section: HTMLElement) {
		const target = section.querySelector<HTMLElement>('[data-item]') ?? section;
		target.focus({ preventScroll: true });
		if (!panorama || innerWidth < SIDEWAYS_MIN_WIDTH)
			return section.scrollIntoView({ block: 'start' });
		const left = section.offsetLeft - parseFloat(getComputedStyle(panorama).paddingLeft);
		glideScrollLeft(panorama, left, motionMode() === 'reduced' ? 0 : tokenMs('--motion-moderate'));
	}

	function goSection(delta: number) {
		const list = sections();
		const at = list.indexOf(currentSection());
		const next = list[Math.min(list.length - 1, Math.max(0, at + delta))];
		if (next) showSection(next);
	}

	function moveItem(delta: number) {
		const items = [...currentSection().querySelectorAll<HTMLElement>('[data-item]')];
		const at = items.findIndex((item) => item.contains(document.activeElement));
		const next = at < 0 ? items[0] : items[Math.min(items.length - 1, Math.max(0, at + delta))];
		next?.focus();
	}

	function answerFocused(option: number) {
		const question = tileOf(focusedItem())?.question ?? questions[0];
		if (question) answer(question, option);
	}

	function stopFocused() {
		const tile = tileOf(focusedItem());
		stopping = tile?.runId ?? runs.find((run) => run.state !== 'paused')?.id;
	}

	function focusProject() {
		const projectId = Number(focusedItem()?.dataset.project);
		const project = projects.find((candidate: ProjectRef) => candidate.id === projectId);
		if (project) shell.focus = project;
	}

	$effect(() =>
		bindKeys({
			side: (count, key) => goSection(key === 'l' ? count : -count),
			move: (count, key) => moveItem(key === 'j' ? count : -count),
			open: () => {
				const href = tileOf(focusedItem())?.href;
				if (href) void goto(href);
			},
			answer: questions.length ? (_count, key) => answerFocused(Number(key)) : undefined,
			stopRun: runs.length ? stopFocused : undefined,
			focusHere: focusProject
		})
	);

	// Arrows are not part of the keymap (a pivot's tabs use them natively), so the panorama takes them itself.
	function arrows(event: KeyboardEvent) {
		if (stopping !== undefined && readKey(event) === 'y') return void stopForm?.requestSubmit();
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if ((event.target as Element | null)?.closest('input, textarea, select, dialog[open]')) return;
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		goSection(event.key === 'ArrowRight' ? 1 : -1);
	}

	const stateWord = (tile: NowTile) => t(`start.state.${tile.state}` as MessageKey);
	const flipMs = () => (motionMode() === 'reduced' ? 0 : tokenMs('--motion-moderate'));
</script>

<svelte:window onkeydown={arrows} />

<h1 class="visually-hidden">{t('start.heading')}</h1>

{#if !projects.length}
	<NoProject />
{:else}
	<div class="start">
		<header class="titles">
			<p class="lage" role="status">
				{#if lageLine}{lageLine}{:else}{t('start.lage.none')}
					<a href="/board">{t('start.lage.toBoard')}</a>{/if}
			</p>
			<p class="today">
				<span>{t('start.today.tokens')}: {numbers.format(data.today.tokens)}</span>
				<span>{t('start.today.cost')}: {costText(data.today.cost)}</span>
				<span class="hint">{t('start.sidewaysHint')}</span>
			</p>
		</header>

		<div class="panorama" data-panorama bind:this={panorama} use:sideways>
			<section aria-labelledby="section-now" class="now" tabindex="-1">
				<h2 id="section-now">{t('start.section.now')}</h2>
				{#if shownTiles.length}
					<ul class="tiles">
						{#each shownTiles as tile, i (tile.key)}
							<li
								class="slot"
								data-size={tile.size}
								style:--i={Math.min(i, 10)}
								animate:flip={{ duration: flipMs }}
							>
								{@render tileContent(tile)}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted">{t('start.now.empty')}</p>
				{/if}
				{#if hiddenLine}<p class="hidden-line">{hiddenLine}</p>{/if}
			</section>

			<section aria-labelledby="section-projects" tabindex="-1">
				<h2 id="section-projects">{t('start.section.projects')}</h2>
				<!-- ponytail: open questions and agents at work stand in for the derived states per project;
				     show their counts from the per-ticket read model once it exists. -->
				<ul class="rows">
					{#each projects as project (project.id)}
						{@const count = countFor(project.id)}
						<li>
							<a
								class="row"
								href="/board"
								data-item="project-{project.id}"
								data-project={project.id}
								aria-current={shell.focus?.id === project.id ? 'true' : undefined}
							>
								<span class="row-head">
									<ProjectTag code={project.code} palette={project.palette} />
									<span class="name">{project.name}</span>
								</span>
								<span class="stats">
									<StatPair
										label={t('start.projects.questions')}
										value={numbers.format(count.questions)}
									/>
									<StatPair
										label={t('start.projects.agents')}
										value={numbers.format(count.agents)}
									/>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>

			<section aria-labelledby="section-operations" tabindex="-1">
				<h2 id="section-operations">{t('start.section.operations')}</h2>
				<p class="runner"><span class="muted">{t('start.ops.runner')}</span> {runnerLine}</p>
				<h3>{t('start.ops.queued')}</h3>
				{#if data.queued.length}
					<ul class="rows" aria-label={t('start.ops.queued')}>
						{#each data.queued as run (run.id)}
							<li
								class="row"
								data-item="queued-{run.id}"
								data-project={run.project.id}
								tabindex="-1"
							>
								<span class="row-head">
									<ProjectTag code={run.project.code} palette={run.project.palette} />
									<a href={runHref(run.project.code, run.number, run.id)}>{run.ticket}</a>
									<span class="muted">{run.profile}</span>
								</span>
								<span class="detail">{run.waitText}</span>
								{#if run.notBefore}
									<span class="detail">
										{t('start.ops.earliest', { time: times.format(new Date(run.notBefore)) })}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted">{t('start.ops.queuedEmpty')}</p>
				{/if}
				<h3>{t('start.ops.finished')}</h3>
				{#if data.finished.length}
					<ul class="rows" aria-label={t('start.ops.finished')}>
						{#each data.finished as run (run.id)}
							<li
								class="row"
								data-item="finished-{run.id}"
								data-project={run.project.id}
								tabindex="-1"
							>
								<span class="row-head">
									<ProjectTag code={run.project.code} palette={run.project.palette} />
									<a href={runHref(run.project.code, run.number, run.id)}>{run.ticket}</a>
									<Tag
										tone={run.state === 'failed'
											? 'error'
											: run.state === 'succeeded'
												? 'success'
												: 'neutral'}>{t(`start.state.${run.state}` as MessageKey)}</Tag
									>
								</span>
								<span class="detail">
									{duration(run.startedAt, run.finishedAt)} · {costText(run.cost)}
								</span>
								{#if run.summary}
									<span class="detail failure">
										{run.summary}
									</span>
								{/if}
								{#if run.failure?.wayOut}
									<span class="detail"
										>{t('start.ops.wayOut', { text: firstLine(run.failure.wayOut) })}</span
									>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted">{t('start.ops.finishedEmpty')}</p>
				{/if}
			</section>

			<section aria-labelledby="section-trace" class="trace" tabindex="-1">
				<h2 id="section-trace">{t('start.section.trace')}</h2>
				{#if data.tracks.length}
					{#each data.tracks as track (track.id)}
						{@const tile = tiles.find((candidate) => candidate.runId === track.id)}
						{@const steps = lastSteps(track.id)}
						<article
							class="track"
							data-item="track-{track.id}"
							data-project={tile?.project.id}
							tabindex="-1"
						>
							<h3>
								{#if tile}<a href={tile.href}>{tile.ticket}</a>{/if}
								<span class="muted">{tile?.run?.profile ?? tile?.question?.profile ?? ''}</span>
							</h3>
							<p class="detail">
								{phaseWord(track.id)} · {t('start.trace.runtime', {
									time: duration(track.startedAt, now)
								})}
							</p>
							{#if steps.length}
								<ol class="steps">
									{#each steps as step (step.number)}
										<li class="mono">{stepLine(step)}</li>
									{/each}
								</ol>
							{:else}
								<p class="muted">{t('start.trace.noSteps')}</p>
							{/if}
						</article>
					{/each}
				{:else}
					<p class="muted">{t('start.trace.empty')}</p>
				{/if}
			</section>
		</div>
	</div>
{/if}

{#snippet tileContent(tile: NowTile)}
	{#if tile.question}
		{@const question = tile.question}
		{@const short = splitLead(question.question)}
		<div class="tile-frame" data-item={tile.key} data-project={tile.project.id} tabindex="-1">
			<Tile tone={tile.tone} size={tile.size}>
				<span class="tile-head">
					<a href={tile.href}>{tile.ticket}</a>
					<Tag tone={tile.tone}>{stateWord(tile)}</Tag>
				</span>
				<span class="question" use:clamped={short.lead}>{short.lead}</span>
				<a
					class="more"
					data-detail={short.rest ? '' : undefined}
					href={tile.href}
					aria-label={t('start.tile.moreLabel', { ref: tile.ticket })}>{t('start.tile.more')}</a
				>
				{#if question.profile}<span class="muted"
						>{t('start.tile.asks', { profile: question.profile })}</span
					>{/if}
				<span class="options">
					{#each question.options.slice(0, 3) as option, index (index)}
						<button
							type="button"
							class="option"
							title={plainText(option.label)}
							onclick={() => answer(question, index + 1)}
							>{t('start.answer.option', {
								number: index + 1,
								label: plainText(option.label)
							})}</button
						>
					{/each}
				</span>
			</Tile>
		</div>
	{:else}
		{@const track = tile.runId
			? data.tracks.find((candidate) => candidate.id === tile.runId)
			: undefined}
		{@const points = track ? (series[track.id] ?? []) : []}
		<div class="tile-frame" data-item={tile.key} data-project={tile.project.id} tabindex="-1">
			<Tile tone={tile.tone} size={tile.size} href={tile.href}>
				<span class="tile-head">
					<span>{tile.ticket}</span>
					<Tag tone={tile.tone}>{stateWord(tile)}</Tag>
				</span>
				{#if tile.run}<span class="muted"
						>{tile.run.profile} · {t(`start.location.${tile.run.location}` as MessageKey)}</span
					>{/if}
				{#if tile.failed?.summary}<span class="failure">{tile.failed.summary}</span>{/if}
				{#if track}
					<span class="muted">{phaseWord(track.id)}</span>
					<span class="figures">
						<StatPair label={t('start.tile.steps')} value={numbers.format(steps[track.id])} />
						<StatPair
							label={t('start.tile.tokens')}
							value={tokenFigure(tokens[track.id], numbers.format)}
						/>
					</span>
					<Sparkline values={tokensOf(points)} label={t('start.tile.tokensPerMinute')} />
					<span class="second-graph">
						<Sparkline
							values={points.map((point) => point.steps)}
							label={t('start.tile.stepsPerMinute')}
						/>
					</span>
				{/if}
			</Tile>
		</div>
	{/if}
{/snippet}

<Dialog
	variant="sheet"
	bind:open={() => stopping !== undefined, (open) => !open && (stopping = undefined)}
	title={t('start.stop.title', { id: stopping ?? '' })}
>
	<p>{t('start.stop.body')}</p>
	<form
		class="confirm"
		method="POST"
		action="?/stop"
		bind:this={stopForm}
		use:enhance={() =>
			async ({ result, update }) => {
				await update();
				if (result.type === 'success') stopping = undefined;
			}}
	>
		<input type="hidden" name="runId" value={stopping} />
		<Button type="button" variant="ghost" onclick={() => (stopping = undefined)}
			>{t('start.stop.keep')}</Button
		>
		<Button type="submit" variant="danger">{t('start.stop.confirm')}</Button>
	</form>
</Dialog>

<style>
	.start {
		--tile-unit: 150px;
		--tile-columns: 4;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.titles p {
		margin: 0;
	}
	.lage,
	.today,
	.detail,
	.muted {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.today {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
		font-variant-numeric: tabular-nums;
	}
	.hint {
		display: none;
	}
	h2 {
		margin: 0 0 var(--space-3);
		font-size: var(--type-group);
		font-weight: var(--weight-light);
		text-transform: lowercase;
	}
	h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--type-body);
		font-weight: var(--weight-medium);
	}
	section:focus-visible,
	[data-item]:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-auto-rows: minmax(120px, auto);
		grid-auto-flow: dense;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-x: clip; /* a tile sliding in must not widen the page */
	}
	.slot {
		display: grid;
		min-width: 0;
	}
	.slot[data-size='2x1'],
	.slot[data-size='2x2'] {
		grid-column: span 2;
	}
	.tile-frame,
	.tile-frame > :global(.tile) {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		height: 100%;
	}
	.tile-head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.tile-frame a {
		color: inherit;
	}
	.question {
		font-size: var(--type-item);
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		white-space: pre-line;
		overflow: hidden;
	}
	.more {
		display: none;
		align-self: start;
		align-items: center;
		min-height: 44px;
		padding-inline: var(--space-2);
		margin-inline: calc(-1 * var(--space-2));
		font-size: var(--type-meta);
		text-decoration: underline;
	}
	.more[data-detail],
	.question:global([data-clamped]) ~ .more {
		display: inline-flex;
	}
	.options {
		display: none;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: auto;
	}
	.option {
		padding: var(--space-1) var(--space-2);
		border: 1px solid currentColor;
		border-radius: var(--radius-tile);
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.figures {
		display: flex;
		gap: var(--space-4);
	}
	.second-graph {
		display: none;
	}
	.failure {
		overflow-wrap: anywhere;
	}
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
		color: inherit;
		text-decoration: none;
	}
	.row-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		overflow-wrap: anywhere;
	}
	.stats {
		display: flex;
		gap: var(--space-4);
	}
	.row[aria-current='true'] .name {
		font-weight: var(--weight-semibold);
	}
	.track {
		padding: var(--space-2) 0 var(--space-3);
		border-bottom: 1px solid var(--rule);
	}
	.track h3 {
		display: flex;
		gap: var(--space-2);
		margin: 0;
	}
	.steps {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-6);
		font-size: var(--type-meta);
	}
	.steps li {
		overflow-wrap: anywhere;
	}
	.hidden-line {
		margin-top: var(--space-2);
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.panorama {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	.panorama > section {
		min-width: 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		:global(:root:not([data-motion='reduced'])) .slot {
			animation: tile-in var(--motion-moderate) var(--ease-base) both;
			animation-delay: calc(var(--i) * 30ms);
		}
	}
	@keyframes tile-in {
		from {
			opacity: 0;
			translate: var(--motion-slide) 0;
		}
	}

	@media (min-width: 760px) {
		/* The start view is a stage: titles and panorama fill the room between head and app bar, the window stays put */
		.start {
			height: var(--stage-h);
			margin: calc(-1 * var(--space-6)) calc(-1 * var(--gutter));
			padding-top: var(--space-4);
		}
		.titles {
			padding-inline: var(--gutter);
		}
		.hint {
			display: inline;
		}
		.panorama {
			flex: 1;
			flex-direction: row;
			gap: 40px;
			min-height: 0;
			padding: 0 var(--gutter) var(--space-3);
			overflow: auto hidden;
			scrollbar-width: thin;
		}
		.panorama > section {
			flex: 0 0 280px;
			overflow-y: auto;
		}
		.panorama > section.now {
			flex-basis: calc(var(--tile-columns) * var(--tile-unit) + (var(--tile-columns) - 1) * 8px);
		}
		.panorama > section:nth-child(3) {
			flex-basis: 340px;
		}
		.panorama > section.trace {
			flex-basis: 440px;
		}
		.tiles {
			grid-template-columns: repeat(var(--tile-columns), var(--tile-unit));
			grid-auto-rows: var(--tile-unit);
		}
		.slot[data-size='2x2'] {
			grid-row: span 2;
		}
		.question {
			-webkit-line-clamp: 3;
			line-clamp: 3;
		}
		.options {
			display: flex;
		}
	}
	@media (min-width: 760px) and (pointer: fine) {
		.more {
			min-height: 0;
		}
	}
	@media (min-width: 1920px) {
		.hint {
			display: none;
		}
	}
	@media (min-width: 2400px) {
		.start {
			--tile-unit: 170px;
			--tile-columns: 6;
		}
		.second-graph {
			display: block;
		}
	}
</style>
