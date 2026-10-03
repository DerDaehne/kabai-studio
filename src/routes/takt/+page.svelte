<script lang="ts">
	import type { ActionResult } from '@sveltejs/kit';
	import { deserialize } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import { tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { focusSummary } from '$lib/shell/focus';
	import { LIVE_DEPENDENCY, openQuestionsLabel } from '$lib/shell/live.svelte';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { shell } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import { auraOpacity } from '$lib/ui/aura';
	import AuraList from '$lib/ui/AuraList.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { tilt } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import { dismiss, toast } from '$lib/ui/toast.svelte';
	import type { PageProps } from './$types';
	import {
		arranged,
		decisionKey,
		deferred,
		queueKey,
		restored,
		taktAurae,
		type QueuedQuestion
	} from './queue';

	type Answer = { option: number } | { text: string };

	let { data }: PageProps = $props();

	let order = $state<number[]>([]);
	const answered = new SvelteSet<number>();
	const queue = $derived(arranged(data.questions, order, answered));
	const view = $derived(focusSummary(queue, shell.focus, (question) => question.project.id));
	const card = $derived(view.visible[0]);
	const aurae = $derived(taktAurae(view.visible));
	const decisionAura = $derived(aurae.get(decisionKey));
	const queueItems = $derived(
		view.visible.map((question) => ({ key: queueKey(question), question }))
	);
	/** A card that comes back through undo turns in from the side it left to. */
	let mirrored = $state(false);

	let ownOpen = $state(false);
	let ownText = $state('');
	let ownField = $state<HTMLTextAreaElement>();
	let ownButton = $state<HTMLButtonElement>();

	const runRecordHref = (question: QueuedQuestion) =>
		`/p/${question.project.code}/t/${question.ticket.number}`;
	const askedLabel = (iso: string) =>
		new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

	async function post(
		action: 'answer' | 'retract',
		fields: Record<string, string>
	): Promise<ActionResult> {
		const body = new FormData();
		for (const [name, value] of Object.entries(fields)) body.set(name, value);
		try {
			const headers = { 'x-sveltekit-action': 'true' };
			const response = await fetch(`/takt?/${action}`, { method: 'POST', body, headers });
			return deserialize(await response.text());
		} catch (error) {
			return { type: 'error', error };
		}
	}

	function failureOf(result: ActionResult): string | undefined {
		if (result.type === 'success') return undefined;
		if (result.type === 'failure') return String(result.data?.message);
		return 'Das hat nicht geklappt. Lade die Seite neu und versuch es noch einmal.';
	}

	const fieldsOf = (given: Answer): Record<string, string> =>
		'text' in given ? { text: given.text } : { option: String(given.option) };

	function sentNotice(question: QueuedQuestion, resumesRun: boolean) {
		const ref = question.ticket.ref;
		if (resumesRun) return `Antwort gesendet · ${ref} setzt in ${data.undoWindowMs / 1000} s fort`;
		return `Antwort gesendet · kein Run setzt ${ref} fort, starte einen für das Ticket`;
	}

	/** Moves on to the next card at once; returns the notice that offers to take the answer back. */
	async function send(question: QueuedQuestion, given: Answer, undo: () => void) {
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
		const action = { label: 'Rückgängig', run: undo };
		return toast(sentNotice(question, resumesRun), 'success', data.undoWindowMs, action);
	}

	async function takeBack(question: QueuedQuestion) {
		const failure = failureOf(await post('retract', { question: String(question.id) }));
		if (failure) return void toast(failure, 'error');
		mirrored = true;
		order = restored(queue, question.id);
		answered.delete(question.id);
		await invalidate(LIVE_DEPENDENCY);
	}

	/** One entry on the shared undo stack, so u, Ctrl+r and the notice's button all take the same way. */
	function answer(question: QueuedQuestion, given: Answer) {
		let notice: number | undefined;
		const action: Undoable = {
			label: `Antwort auf ${question.ticket.ref}`,
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

	$effect(() => {
		const current = card;
		if (!current) return;
		return bindKeys({
			answer: current.options.length ? (_count, key) => choose(current, Number(key)) : undefined,
			answerOwn: () => void openOwnAnswer(),
			later: () => later(current),
			open: () => void goto(runRecordHref(current)),
			focusHere: () => (shell.focus = current.project)
		});
	});
</script>

<div class="takt">
	<nav class="queue" aria-label="Warteschlange">
		<h1>Takt <span class="status">{openQuestionsLabel(view.visible.length)}</span></h1>
		{#if queueItems.length}
			<AuraList items={queueItems} {aurae} label="Offene Fragen">
				{#snippet item({ question })}
					<div class="entry" aria-current={question === card ? 'true' : undefined}>
						<ProjectTag code={question.project.code} palette={question.project.palette} />
						<span class="ref">{question.ticket.ref}</span>
						<span class="text">{question.question}</span>
					</div>
				{/snippet}
			</AuraList>
		{/if}
		{#if view.hiddenLabel}<p class="hidden-line">{view.hiddenLabel}</p>{/if}
	</nav>

	<section class="stage" aria-label="Entscheidung">
		<p class="visually-hidden" aria-live="polite">
			{card ? `${card.ticket.ref}: ${card.question}` : 'Nichts wartet auf dich'}
		</p>
		{#if card}
			{#key card.id}
				<div class="decision" in:tilt={{ reverse: mirrored }} out:tilt={{ reverse: mirrored }}>
					<div
						class="glow"
						aria-hidden="true"
						data-strength={decisionAura?.strength}
						style:opacity={decisionAura ? auraOpacity[decisionAura.strength] : 0}
						style:background-color={decisionAura?.color}
					></div>
					<article class="card" aria-labelledby="question-{card.id}">
						<p class="meta">
							<ProjectTag code={card.project.code} palette={card.project.palette} />
							<span class="ref">{card.ticket.ref}</span>
							<span class="title">{card.project.name} · {card.ticket.title}</span>
							{#if card.profile}<span class="who">{card.profile} fragt</span>{/if}
							<span
								>wartet seit <time datetime={card.askedAt}>{askedLabel(card.askedAt)}</time></span
							>
						</p>
						<h2 class="question" id="question-{card.id}">{card.question}</h2>
						<div class="options" role="group" aria-label="Antworten">
							{#each card.options as option, index (index)}
								<button
									type="button"
									class="option"
									onclick={() => answer(card, { option: index + 1 })}
								>
									<Kbd key={String(index + 1)} />
									<span class="label">{option.label}</span>
									{#if option.effect}<span class="effect">{option.effect}</span>{/if}
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
									<label class="visually-hidden" for="own-answer">Eigene Antwort an den Agent</label
									>
									<textarea
										id="own-answer"
										rows="3"
										bind:this={ownField}
										bind:value={ownText}
										onkeydown={ownAnswerKeys}></textarea>
									<div class="own-row">
										<span class="muted"
											><Kbd key="Enter" /> senden · <Kbd key="Escape" /> verwerfen</span
										>
										<button type="button" class="btn" onclick={closeOwnAnswer}>Verwerfen</button>
										<button class="btn btn-primary" disabled={!ownText.trim()}>Senden</button>
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
									<span class="label">Eigene Antwort</span>
									<span class="effect">Freitext, kommt beim Agent strukturiert an</span>
								</button>
							{/if}
						</div>
						<p class="actions">
							<button type="button" class="btn btn-ghost" onclick={() => later(card)}
								>Später <Kbd key="s" /></button
							>
							<a class="btn btn-ghost" href={runRecordHref(card)}>Run-Akte <Kbd key="Enter" /></a>
						</p>
					</article>
				</div>
			{/key}
		{:else}
			<EmptyState title="Nichts wartet auf dich">
				Die Agents arbeiten weiter; fragt einer, erscheint seine Frage hier.
				{#snippet action()}
					<a class="btn" href="/">Zum Stellwerk <Kbd key="g" /><Kbd key="s" /></a>
				{/snippet}
			</EmptyState>
		{/if}
	</section>
</div>

<style>
	.takt {
		display: grid;
		grid-template-columns: minmax(200px, 300px) minmax(0, 720px);
		gap: var(--space-6);
		align-items: start;
	}
	h1 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}
	.status,
	.hidden-line {
		color: var(--text-muted);
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.hidden-line {
		margin-top: var(--space-3);
	}
	.entry {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 36px;
		padding: var(--space-1) var(--space-2);
		border-radius: 10px;
	}
	.entry[aria-current='true'] {
		background: var(--fill-sel);
	}
	.entry .text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ref {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	/* A tilting card never scrolls the page sideways; the glow stays within the card width, so no edge shows */
	.stage {
		display: grid;
		overflow-x: clip;
		overflow-clip-margin: 24px;
	}
	.decision {
		position: relative;
		isolation: isolate;
		grid-area: 1 / 1;
		min-width: 0;
		backface-visibility: hidden;
	}
	.glow {
		position: absolute;
		z-index: -1;
		inset: 20% 16px -12px;
		border-radius: 40px;
		filter: blur(28px);
		pointer-events: none;
		transition:
			opacity var(--dur-slow) var(--ease-out),
			background-color var(--dur-slow) var(--ease-out);
	}
	.card {
		padding: var(--space-6);
		border-radius: var(--radius-xl);
		background: var(--glass-card);
		backdrop-filter: blur(var(--blur-card)) saturate(var(--glass-sat));
		box-shadow: var(--shadow-card);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.who {
		color: var(--text);
	}
	.question {
		margin-top: var(--space-3);
		font-size: var(--text-display);
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	.options {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}
	.option {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: center;
		column-gap: var(--space-3);
		min-height: 52px;
		padding: var(--space-2) var(--space-3);
		border: 0;
		border-radius: var(--radius-lg);
		background: var(--fill-soft);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.option:hover {
		background: var(--fill-sel);
	}
	.option :global(kbd) {
		grid-row: span 2;
		width: 28px;
		height: 28px;
	}
	.label {
		font-weight: 620;
	}
	.effect {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.own {
		display: grid;
		gap: var(--space-2);
	}
	.own-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}
	.own-row .muted {
		margin-right: auto;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}

	/* Phones: the card first and alone; the queue shrinks to its count and the line about hidden projects */
	@media (max-width: 719px) {
		.takt {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-3);
		}
		.queue :global(.aura-list) {
			display: none;
		}
		h1 {
			margin-bottom: 0;
		}
		.stage {
			overflow-clip-margin: 12px;
		}
		.card {
			padding: var(--space-4);
		}
		.option {
			min-height: 56px;
		}
	}
</style>
