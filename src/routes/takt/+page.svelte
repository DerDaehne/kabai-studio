<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { MediaQuery, SvelteSet } from 'svelte/reactivity';
	import { leadText, plainText, splitLead } from '$lib/markdown';
	import { answerHold } from '$lib/answer-hold';
	import { failureOf, postAction } from '$lib/form-action';
	import type { MessageKey } from '$lib/i18n';
	import { t } from '$lib/i18n/t';
	import { focusSummary, inFocus } from '$lib/shell/focus';
	import { resumeAll, resumeRun } from '$lib/shell/halt';
	import { invalidateLive } from '$lib/shell/live.svelte';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { shell } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import AgentText from '$lib/ui/AgentText.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import Pivot, { type Facet } from '$lib/ui/Pivot.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import { dismiss, toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';
	import FinishedRuns from './FinishedRuns.svelte';
	import LiveRuns from './LiveRuns.svelte';
	import { arranged, deferred, restored, type QueuedQuestion } from './queue';
	import { ticketHref } from '$lib/links';

	type Answer = { option: number } | { text: string };

	let { data }: PageProps = $props();

	const locale = $derived(page.data.locale);
	const panorama = new MediaQuery('min-width: 1300px', false);
	let active = $state('questions');

	let order = $state<number[]>([]);
	const answered = new SvelteSet<number>();
	const queue = $derived(arranged(data.questions, order, answered));
	const view = $derived(focusSummary(queue, shell.focus, (question) => question.project.id));
	const card = $derived(view.visible[0]);
	const cardQuestion = $derived(card ? splitLead(card.question) : undefined);
	const upcoming = $derived(view.visible.slice(1));
	/** A card that comes back through undo slides in from the side it left to. */
	let mirrored = $state(false);
	/** Set by the first real advance, so the card does not animate when the page opens or arrives. */
	let advanced = $state(false);

	const liveRuns = $derived(
		(data.live?.runs ?? []).filter((run) => inFocus(shell.focus, run.project.id))
	);
	const working = $derived(
		liveRuns.filter((run) => run.state !== 'paused' && run.state !== 'queued')
	);
	const paused = $derived(liveRuns.filter((run) => run.state === 'paused'));
	const finished = $derived(data.finished.filter((run) => inFocus(shell.focus, run.project.id)));

	const facets = $derived<Facet[]>([
		{
			id: 'questions',
			label: t('takt.facet.questions'),
			count: view.visible.length,
			width: '720px'
		},
		{ id: 'running', label: t('takt.facet.running'), count: working.length },
		{ id: 'paused', label: t('takt.facet.paused'), count: paused.length },
		{ id: 'finished', label: t('takt.facet.finished'), count: finished.length }
	]);

	const plural = $derived(new Intl.PluralRules(locale));
	const countLabel = $derived(
		t(`takt.open.${plural.select(view.visible.length) === 'one' ? 'one' : 'other'}`, {
			count: view.visible.length
		})
	);
	const hiddenLine = $derived.by(() => {
		const hidden = queue.filter((question) => !view.visible.includes(question));
		if (!hidden.length) return '';
		const projects = new Set(hidden.map((question) => question.project.id)).size;
		const key: MessageKey =
			plural.select(projects) === 'one' ? 'start.hidden.one' : 'start.hidden.other';
		return t(key, { count: hidden.length, projects });
	});
	const asked = $derived(
		new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
	);

	let ownOpen = $state(false);
	let ownText = $state('');
	let ownField = $state<HTMLTextAreaElement>();
	let ownButton = $state<HTMLButtonElement>();

	const post = (action: 'answer' | 'retract', fields: Record<string, string>) =>
		postAction(`/takt?/${action}`, fields);

	const fieldsOf = (given: Answer): Record<string, string> =>
		'text' in given ? { text: given.text } : { option: String(given.option) };

	function sentNotice(question: QueuedQuestion, resumesRun: boolean) {
		const ref = question.ticket.ref;
		return resumesRun
			? t('takt.sent', { ref, seconds: data.undoWindowMs / 1000 })
			: t('takt.sentNoRun', { ref });
	}

	/** Moves on to the next card at once; returns the notice that offers to take the answer back. */
	async function send(question: QueuedQuestion, given: Answer, undo: () => void) {
		advanced = true;
		mirrored = false;
		answered.add(question.id);
		const result = await post('answer', { question: String(question.id), ...fieldsOf(given) });
		const failure = failureOf(result);
		if (failure) {
			answered.delete(question.id);
			toast(failure, 'error');
			return undefined;
		}
		const resumesRun = result.type === 'success' && result.data?.resumesRun === true;
		const action = {
			label: t('takt.undo'),
			run: undo,
			countdown: true,
			hold: resumesRun ? answerHold(question.id, data.holdBeatMs) : undefined
		};
		return toast(sentNotice(question, resumesRun), 'success', data.undoWindowMs, action);
	}

	async function takeBack(question: QueuedQuestion) {
		const failure = failureOf(await post('retract', { question: String(question.id) }));
		if (failure) return void toast(failure, 'error');
		mirrored = true;
		advanced = true;
		order = restored(queue, question.id);
		answered.delete(question.id);
		await invalidateLive();
	}

	/** One entry on the shared undo stack, so u, Ctrl+r and the notice's button all take the same way. */
	function answer(question: QueuedQuestion, given: Answer) {
		let notice: number | undefined;
		const action: Undoable = {
			label: t('takt.answerLabel', { ref: question.ticket.ref }),
			perform: () =>
				void send(question, given, () => undoStack.revert(action)).then((id) => (notice = id)),
			revert: () => {
				if (notice !== undefined) dismiss(notice);
				void takeBack(question);
			}
		};
		undoStack.perform(action);
	}

	function choose(question: QueuedQuestion, option: number) {
		if (option <= question.options.length) answer(question, { option });
	}

	function later(question: QueuedQuestion) {
		advanced = true;
		mirrored = false;
		order = deferred(queue, question.id);
	}

	async function openOwnAnswer() {
		ownOpen = true;
		await tick();
		ownField?.focus();
	}

	function closeOwnAnswer() {
		ownOpen = false;
		ownText = '';
	}

	function sendOwnAnswer() {
		const text = ownText;
		if (!card || !text.trim()) return;
		closeOwnAnswer();
		answer(card, { text });
	}

	// The key router stays out of text fields, so the field handles its own Enter and Escape.
	async function ownAnswerKeys(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			sendOwnAnswer();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closeOwnAnswer();
			await tick();
			ownButton?.focus();
		}
	}

	const cardInFront = $derived(panorama.current || active === 'questions');

	$effect(() => {
		const current = card;
		if (!current || !cardInFront) return;
		return bindKeys({
			answer: current.options.length ? (_count, key) => choose(current, Number(key)) : undefined,
			answerOwn: () => void openOwnAnswer(),
			later: () => later(current),
			open: () =>
				void goto(ticketHref(current.project.code, current.ticket.number, { run: current.runId })),
			focusHere: () => (shell.focus = current.project)
		});
	});
</script>

<svelte:head><title>{t('takt.title')}</title></svelte:head>

<div class="takt">
	<h1 class="visually-hidden">{t('takt.heading')} <span class="status">{countLabel}</span></h1>
	{#if hiddenLine}<p class="hidden-line">{hiddenLine}</p>{/if}

	<Pivot {facets} bind:active label={t('takt.facets')}>
		{#snippet panel(facet)}
			{#if facet.id === 'questions'}
				{@render questions()}
			{:else if facet.id === 'running'}
				<div class="live" data-testid="live-column">
					<LiveRuns runs={working} tracks={data.tracks} />
				</div>
			{:else if facet.id === 'paused'}
				{@render pausedRuns()}
			{:else}
				<FinishedRuns runs={finished} />
			{/if}
		{/snippet}
	</Pivot>
</div>

{#snippet questions()}
	<div class="questions">
		<p class="visually-hidden" aria-live="polite">
			{card ? `${card.ticket.ref}: ${leadText(card.question)}` : t('takt.nothing')}
		</p>
		{#if card}
			{#key card.id}
				<article
					class="decision"
					class:advanced
					class:back={mirrored}
					aria-labelledby="question-{card.id}"
					data-testid="decision"
				>
					<p class="meta">
						<ProjectTag code={card.project.code} palette={card.project.palette} />
						<span class="ref">{card.ticket.ref}</span>
						<span class="title">{card.project.name} · {card.ticket.title}</span>
						{#if card.profile}<span class="who">{t('takt.asks', { profile: card.profile })}</span
							>{/if}
						<time datetime={card.askedAt}
							>{t('takt.waitingSince', { time: asked.format(new Date(card.askedAt)) })}</time
						>
					</p>
					<h2 class="question" id="question-{card.id}">{cardQuestion?.lead}</h2>
					{#if cardQuestion?.rest}<div class="question-rest">
							<AgentText text={cardQuestion.rest} />
						</div>{/if}
					<div class="options" role="group" aria-label={t('takt.answers')}>
						{#each card.options as option, index (index)}
							<button
								type="button"
								class="option"
								onclick={() => answer(card, { option: index + 1 })}
							>
								<Kbd key={String(index + 1)} />
								<span class="label">{plainText(option.label)}</span>
								{#if option.effect}<span class="effect">{plainText(option.effect)}</span>{/if}
							</button>
						{/each}
						{#if ownOpen}
							<form
								class="own"
								onsubmit={(event) => {
									event.preventDefault();
									sendOwnAnswer();
								}}
							>
								<label class="visually-hidden" for="own-answer">{t('takt.ownAnswerLabel')}</label>
								<textarea
									id="own-answer"
									rows="3"
									bind:this={ownField}
									bind:value={ownText}
									onkeydown={ownAnswerKeys}></textarea>
								<div class="own-row">
									<span class="muted">
										<Kbd key="Enter" />
										{t('takt.keySend')} · <Kbd key="Escape" />
										{t('takt.keyDiscard')}
									</span>
									<button type="button" class="rk-btn" onclick={closeOwnAnswer}
										>{t('takt.discard')}</button
									>
									<button class="rk-btn rk-btn--primary" disabled={!ownText.trim()}
										>{t('takt.send')}</button
									>
								</div>
							</form>
						{:else}
							<button
								type="button"
								class="option own-open"
								bind:this={ownButton}
								onclick={openOwnAnswer}
							>
								<Kbd key="i" />
								<span class="label">{t('takt.ownAnswer')}</span>
								<span class="effect">{t('takt.ownAnswerHint')}</span>
							</button>
						{/if}
					</div>
					<p class="actions">
						<button type="button" class="rk-btn rk-btn--quiet" onclick={() => later(card)}
							>{t('takt.later')} <Kbd key="s" /></button
						>
						<a
							class="rk-btn rk-btn--quiet"
							href={ticketHref(card.project.code, card.ticket.number, { run: card.runId })}
							>{t('takt.runRecord')} <Kbd key="Enter" /></a
						>
					</p>
				</article>
			{/key}
			{#if upcoming.length}
				<h3 class="next">{t('takt.next')}</h3>
				<ol class="upcoming" aria-label={t('takt.next')}>
					{#each upcoming as question (question.id)}
						<li>
							<ProjectTag code={question.project.code} palette={question.project.palette} />
							<span class="ref">{question.ticket.ref}</span>
							<span class="text">{leadText(question.question)}</span>
						</li>
					{/each}
				</ol>
			{/if}
		{:else}
			<EmptyState title={t('takt.nothing')}>
				{t('takt.nothingHint')}
				{#snippet action()}
					<a class="rk-btn" href="/">{t('takt.toStart')} <Kbd key="g" /><Kbd key="s" /></a>
				{/snippet}
			</EmptyState>
		{/if}
	</div>
{/snippet}

{#snippet pausedRuns()}
	{#if paused.length}
		<p class="detail">{t('takt.paused.hint')}</p>
		<p>
			<button type="button" class="rk-btn" onclick={() => void resumeAll()}
				>{t('takt.resumeAll')}</button
			>
		</p>
		<ul class="rows" data-testid="paused-runs">
			{#each paused as run (run.id)}
				<li class="row">
					<ProjectTag code={run.project.code} palette={run.project.palette} />
					<a
						href={ticketHref(run.project.code, run.ticket.split('-').at(-1) ?? '', { run: run.id })}
						>{run.ticket}</a
					>
					<Tag tone="warning">{t('start.state.paused')}</Tag>
					<button
						type="button"
						class="rk-btn"
						aria-label={t('takt.resumeRun', { ticket: run.ticket })}
						onclick={() => void resumeRun(run.id)}>{t('takt.resume')}</button
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="detail">{t('takt.paused.empty')}</p>
	{/if}
{/snippet}

<style>
	.status,
	.hidden-line,
	.detail {
		color: var(--text-muted);
		font-size: var(--type-meta);
		font-weight: 400;
	}
	.hidden-line {
		margin: 0 0 var(--space-3);
	}
	.ref {
		font-family: var(--font-mono);
		font-size: var(--type-meta);
		white-space: nowrap;
	}
	/* a card sliding in must not give its facet a sideways scrollbar for a moment */
	.questions {
		overflow-x: clip;
		overflow-clip-margin: 8px;
	}
	.decision {
		padding: var(--space-4) 0;
	}
	.decision.advanced {
		animation: card-in calc(var(--motion-moderate) * 0.75) var(--ease-out);
	}
	.decision.advanced.back {
		animation-name: card-back;
	}
	@keyframes card-in {
		from {
			opacity: 0;
			translate: var(--motion-slide) 0;
		}
	}
	@keyframes card-back {
		from {
			opacity: 0;
			translate: calc(var(--motion-slide) * -1) 0;
		}
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.who {
		color: var(--text);
	}
	.question {
		margin-top: var(--space-3);
		font-size: var(--type-title);
		font-weight: var(--weight-light);
		line-height: 1.25;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.question-rest {
		margin-top: var(--space-3);
	}
	.options {
		display: grid;
		margin-top: var(--space-4);
	}
	.option {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: center;
		column-gap: var(--space-3);
		min-height: 52px;
		padding: var(--space-3) var(--space-2);
		border: 0;
		border-top: 1px solid var(--rule);
		background: none;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.options > :last-child {
		border-bottom: 1px solid var(--rule);
	}
	.option:hover .label {
		text-decoration: underline;
	}
	.option :global(kbd) {
		grid-row: span 2;
		width: 28px;
		height: 28px;
	}
	.label {
		font-weight: var(--weight-semibold);
	}
	.effect {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.own {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-2);
		border-top: 1px solid var(--rule);
	}
	.own-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--type-meta);
	}
	.own-row .muted {
		margin-right: auto;
		color: var(--text-muted);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}
	.next {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--type-body);
		font-weight: var(--weight-medium);
	}
	.upcoming,
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.upcoming li,
	.rows .row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--rule);
		overflow-wrap: anywhere;
	}

	@media (max-width: 759px) {
		.option {
			min-height: 56px;
		}
	}
</style>
