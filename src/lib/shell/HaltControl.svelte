<script lang="ts">
	import { globalHaltCommands } from './commands';
	import { pauseAll, resumeAll, stopAll } from './halt';
	import { live, pauseQuestion, stopQuestion } from './live.svelte';
	import { readKey } from './router.svelte';
	import { bindCommands } from './shell.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import { toast } from '$lib/ui/toast.svelte';

	/** Focuses the command line on `:fortsetzen `, so it offers the halted runs to pick from; owned by the layout. */
	let { openResumePrompt }: { openResumePrompt: () => void } = $props();

	const haltedRuns = $derived(live.runs.filter((run) => run.state === 'paused'));

	function askWhichRun() {
		toast(
			haltedRuns.length
				? 'Welchen Run? :fortsetzen N setzt einen angehaltenen fort, :fortsetzen all alle.'
				: 'Gerade ist kein Run angehalten; :fortsetzen all löst einen Halt.'
		);
		openResumePrompt();
	}

	const CONFIRMATIONS = {
		stop: {
			title: 'Alle Agents stoppen?',
			question: stopQuestion,
			action: 'Stoppen (y)',
			run: stopAll
		},
		pause: {
			title: 'Alle Agents anhalten?',
			question: pauseQuestion,
			action: 'Anhalten (y)',
			run: pauseAll
		}
	};
	/** The global `:stop` or `:anhalten` waiting for its confirmation. */
	let confirming = $state<keyof typeof CONFIRMATIONS>();
	const confirmation = $derived(confirming && CONFIRMATIONS[confirming]);

	async function confirm() {
		const run = confirmation?.run;
		confirming = undefined;
		await run?.();
	}

	// The router stays out of open dialogs, so the confirmation takes its y itself — with Alt when single keys are off.
	function confirmWithY(event: KeyboardEvent) {
		if (confirming && readKey(event) === 'y') {
			event.preventDefault();
			void confirm();
		}
	}

	// pre: a view's own normal $effect must see this bound already, so its own `:anhalten`/`:fortsetzen` can win
	// (see the note on the layout's own bindCommands effect)
	$effect.pre(() =>
		bindCommands(
			globalHaltCommands({
				confirmStop: () => (confirming = 'stop'),
				confirmPause: () => (confirming = 'pause'),
				askWhichRun,
				resumeAll: () => void resumeAll()
			})
		)
	);
</script>

<svelte:window onkeydown={confirmWithY} />

<Dialog
	bind:open={() => confirming !== undefined, (open) => !open && (confirming = undefined)}
	title={confirmation?.title ?? ''}
>
	<p>{confirmation?.question(live.activeRuns)}</p>
	{#snippet footer()}
		<Button onclick={() => (confirming = undefined)}>Weiterlaufen lassen</Button>
		<Button variant="danger" onclick={confirm}>{confirmation?.action}</Button>
	{/snippet}
</Dialog>
