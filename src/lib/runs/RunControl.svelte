<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { bindKeys, readKey } from '$lib/shell/router.svelte';
	import { shell } from '$lib/shell/shell.svelte';
	import { RUN_STATES } from '$lib/trace/RunTrace.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import {
		durationText,
		isStoppable,
		originText,
		runCommands,
		stopTarget,
		usageText,
		type RunStart,
		type RunTab
	} from './run-control';

	type FormError = { action: string; message: string; hint: string } | null | undefined;

	/** `selected`: the run the trace shows; `form`: the page's action result, shown at the form it belongs to. */
	let {
		runs,
		start,
		selected,
		form
	}: { runs: RunTab[]; start: RunStart; selected?: number; form?: FormError } = $props();

	let profileId = $derived(start.preselected);
	let startForm: HTMLFormElement | undefined = $state();
	let stopForm: HTMLFormElement | undefined = $state();
	/** The run the open confirmation would stop. */
	let stopping = $state<RunTab>();
	const target = $derived(stopTarget(runs, selected));

	async function startWith(id: number) {
		profileId = id;
		await tick();
		startForm?.requestSubmit();
	}

	$effect(() => {
		shell.viewCommands = runCommands(start.profiles, profileId, startWith);
		return () => (shell.viewCommands = []);
	});
	$effect(() => bindKeys({ stopRun: target ? () => (stopping = target) : undefined }));

	// The router stays out of open dialogs, so the stop confirmation takes its y itself — with Alt when single keys are off.
	function confirmWithY(event: KeyboardEvent) {
		if (!stopping || readKey(event) !== 'y') return;
		event.preventDefault();
		stopForm?.requestSubmit();
	}

	let now = $state(Date.now());
	$effect(() => {
		if (!runs.some((tab) => tab.startedAt && !tab.finishedAt)) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const facts = (tab: RunTab) =>
		[tab.profile ?? 'Profil gelöscht', durationText(tab, now), usageText(tab)]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:window onkeydown={confirmWithY} />

{#snippet formError(action: string)}
	{#if form?.action === action}<p role="alert">{form.message} {form.hint}</p>{/if}
{/snippet}

<section class="runs" aria-label="Runs">
	{#if start.profiles.length}
		<form class="start" method="POST" action="?/start" use:enhance bind:this={startForm}>
			<FormField label="Agent-Profil">
				{#snippet children(a)}<select {...a} name="profileId" bind:value={profileId}>
						{#each start.profiles as profile (profile.id)}
							<option value={profile.id}>{profile.name}</option>
						{/each}
					</select>{/snippet}
			</FormField>
			<Button type="submit" variant="primary" size="sm">Run starten (:run)</Button>
		</form>
		{@render formError('start')}
	{:else}
		<EmptyState title="Noch kein Agent-Profil">
			Ein Run braucht ein Agent-Profil, lokal oder in der Cloud.
			{#snippet action()}<a class="btn btn-primary" href="/settings/profiles"
					>Agent-Profil anlegen</a
				>{/snippet}
		</EmptyState>
	{/if}

	{#if runs.length}
		<nav aria-label="Runs dieses Tickets">
			<ol class="tabs">
				{#each runs as tab (tab.id)}
					{@const state = RUN_STATES[tab.state]}
					{@const origin = originText(tab)}
					<li class:selected={tab.id === selected}>
						<a
							class="tab"
							href="?run={tab.id}"
							aria-current={tab.id === selected ? 'page' : undefined}
						>
							Run {tab.id}
							<Badge tone={state.tone}>{state.label}</Badge>
						</a>
						<p class="facts">{facts(tab)}</p>
						{#if origin}
							<p class="facts">
								{origin} · <a href="?run={tab.resumedFrom}">aus Run {tab.resumedFrom}</a>
							</p>
						{/if}
						{#if tab.waitText}<p class="wait" role="status">{tab.waitText}</p>{/if}
						{#if isStoppable(tab)}
							<Button size="sm" variant="ghost" onclick={() => (stopping = tab)}>
								Stoppen{tab === target ? ' (x)' : ''}
							</Button>
						{/if}
					</li>
				{/each}
			</ol>
		</nav>
	{/if}
</section>

<Dialog
	bind:open={() => stopping !== undefined, (open) => !open && (stopping = undefined)}
	title="Run {stopping?.id} stoppen?"
>
	{#if stopping}
		<p>
			Der Agent bricht sofort ab. Das lässt sich nicht rückgängig machen — für einen neuen Versuch
			startest du einen neuen Run.
		</p>
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
			<input type="hidden" name="runId" value={stopping.id} />
			{@render formError('stop')}
			<Button type="button" variant="ghost" onclick={() => (stopping = undefined)}>Abbrechen</Button
			>
			<Button type="submit" variant="danger">Stoppen (y)</Button>
		</form>
	{/if}
</Dialog>

<style>
	.runs {
		display: grid;
		grid-template-columns: minmax(
			0,
			1fr
		); /* lets the tab row scroll inside instead of widening the page */
		gap: var(--space-3);
		margin-top: var(--space-3);
	}
	.start {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2);
	}
	.tabs {
		display: flex;
		gap: var(--space-2);
		margin: 0;
		padding: 0 0 var(--space-1);
		overflow-x: auto;
		list-style: none;
	}
	.tabs li {
		display: grid;
		flex: 0 0 auto;
		align-content: start;
		justify-items: start;
		gap: var(--space-1);
		width: min(19rem, 78vw);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--surface-sunken);
	}
	.tabs li.selected {
		background: var(--fill-sel);
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: inherit;
		font-weight: 620;
	}
	.facts,
	.wait {
		margin: 0;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.facts {
		color: var(--text-muted);
	}
	.confirm {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	.confirm [role='alert'] {
		flex-basis: 100%;
	}
</style>
