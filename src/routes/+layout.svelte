<script lang="ts">
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';
	import { afterNavigate, goto, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import AppBar from '$lib/shell/AppBar.svelte';
	import CommandLine from '$lib/shell/CommandLine.svelte';
	import {
		focusCommands,
		globalCommands,
		resumeCommands,
		type Suggestion
	} from '$lib/shell/commands';
	import { projectForLetter } from '$lib/shell/focus';
	import { resumeAll, resumeRun } from '$lib/shell/halt';
	import HeadPivot from '$lib/shell/HeadPivot.svelte';
	import KeyHints from '$lib/shell/KeyHints.svelte';
	import { keyContextOf, validKeys } from '$lib/shell/keys';
	import KeyOverview from '$lib/shell/KeyOverview.svelte';
	import {
		connectLive,
		gateLiveInvalidation,
		haltLabel,
		invalidateLive,
		live,
		showLive
	} from '$lib/shell/live.svelte';
	import { bindKeys, handleKey, restoreSingleKeys, setSingleKeys } from '$lib/shell/router.svelte';
	import { bindCommands, boundCommands, shell } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { transitionPage } from '$lib/ui/motion';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Toaster from '$lib/ui/Toaster.svelte';
	import { toast } from '$lib/ui/toast.svelte';

	let { data, children } = $props();

	const path: string = $derived(page.url.pathname);
	const bare = $derived(path === '/login' || path === '/setup');

	let commandValue = $state('');
	let commandOpen = $state(false);
	const commandLineKeys = validKeys('commandline', '', new Set()).hints;
	const haltedRuns = $derived(live.runs.filter((run) => run.state === 'paused'));
	const sources = $derived({
		commands: [
			...boundCommands(),
			...focusCommands(live.projects),
			...resumeCommands(haltedRuns, commandValue, (id) => void resumeRun(id))
		],
		view: shell.viewItems,
		tickets: shell.tickets
	});

	// The sheet is plain state, not a shallow-routing entry: invalidate() resets page.state, so every live event
	// would close it. The back gesture of a phone still closes a modal dialog natively.
	function openCommandLine(mode: string) {
		commandValue = mode;
		commandOpen = true;
	}

	async function execute(suggestion: Suggestion) {
		commandOpen = false;
		if (suggestion.run) suggestion.run();
		else if (suggestion.href) await goto(suggestion.href);
	}

	let keysOpen = $state(false);

	// a sheet belongs to the page it was opened on; invalidate() is no navigation, so live events leave it open
	afterNavigate(() => {
		commandOpen = false;
		keysOpen = false;
	});

	function announce(verb: string, actions: Undoable[]) {
		if (actions.length) toast(`${verb}: ${actions.map((action) => action.label).join(', ')}`);
	}

	onMount(restoreSingleKeys);
	$effect(() => {
		if (bare) return;
		return bindKeys({
			search: () => openCommandLine('/'),
			command: () => openCommandLine(':'),
			help: () => (keysOpen = true),
			goStellwerk: () => goto('/'),
			goTakt: () => goto('/takt'),
			goBoard: () => goto('/board'),
			jumpBack: () => history.back()
		});
	});
	// focusAll only while something is focused, focusProject only while there is a project to focus — otherwise the
	// keys overview would offer a key that does nothing
	$effect(() => {
		if (bare) return;
		return bindKeys({
			focusAll: shell.focus ? () => (shell.focus = null) : undefined,
			focusProject: live.projects.length
				? (_count, key) => {
						const project = projectForLetter(live.projects, key);
						if (project) shell.focus = project;
					}
				: undefined
		});
	});
	// u and Ctrl+r are only valid while there is something to take back or repeat
	$effect(() =>
		bindKeys({
			undo: undoStack.done.length
				? (count) => announce('Rückgängig', undoStack.undo(count))
				: undefined,
			redo: undoStack.undone.length
				? (count) => announce('Wiederholt', undoStack.redo(count))
				: undefined
		})
	);

	type Preference = { name: 'theme' | 'motion'; value: string };
	const preferences: Record<string, Preference> = {
		'theme-light': { name: 'theme', value: 'light' },
		'theme-dark': { name: 'theme', value: 'dark' },
		'theme-system': { name: 'theme', value: 'system' },
		'motion-reduced': { name: 'motion', value: 'reduced' },
		'motion-system': { name: 'motion', value: 'system' }
	};

	// Appearance preferences are data attributes on <html> (read by the stylesheets and motion.ts) and are kept in
	// localStorage; app.html restores them before the first paint. "system" follows the operating system.
	function storePreference({ name, value }: Preference) {
		const root = document.documentElement;
		if (value === 'system') delete root.dataset[name];
		else root.dataset[name] = value;
		try {
			if (value === 'system') localStorage.removeItem(`studio-${name}`);
			else localStorage.setItem(`studio-${name}`, value);
		} catch {
			// without storage (private mode) the choice lasts until the next reload
		}
	}

	const globalCommandList = globalCommands({
		setPreference: (id) => storePreference(preferences[id]),
		setSingleKeys
	});
	// pre, like showLive: a view's own normal $effect runs before the layout's, so binding here first (not as a normal
	// $effect) is what lets a view's `:run` etc. win over this one — see HaltControl.svelte for stop/pause/resume.
	$effect.pre(() => {
		if (bare) return;
		return bindCommands(globalCommandList);
	});

	gateLiveInvalidation();
	onNavigate(transitionPage);

	const signedIn = $derived(data.live !== undefined);
	// pre: runs before the effects of the page, so a page that shows agents of its own (/dev/ui) is not overwritten
	$effect.pre(() => {
		if (data.live) showLive(data.live);
	});
	$effect(() => {
		if (!signedIn) return;
		const connection = connectLive(() => void invalidateLive());
		return () => connection.close();
	});
</script>

<svelte:head>
	<title>kabai studio</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<svelte:window onkeydown={handleKey} />

<!-- Attribution required by LICENSE (additional term §7b): the original project and author stay visible -->
{#snippet attribution()}
	<p class="attribution">
		<a href="https://github.com/DerDaehne/kabai-studio">kabai-studio</a> von DerDaehne · Freie Software,
		AGPL-3.0
	</p>
{/snippet}

{#if bare}
	<div class="bare">
		<div class="brand"><img src={favicon} alt="" width="20" height="20" />kabai studio</div>
		<main id="main">{@render children()}</main>
		{@render attribution()}
	</div>
{:else}
	<div class="shell">
		<a class="skip btn" href="#main">Zum Inhalt springen</a>
		<HeadPivot />

		<main id="main" tabindex="-1">
			{#if live.halt}
				<div class="halt-banner" data-tone={live.halt === 'stop' ? 'error' : 'warning'}>
					<Icon name={live.halt === 'stop' ? 'stop' : 'pause'} />
					<span role="status">{haltLabel(live.halt, live.runs)}</span>
					<Button size="sm" onclick={resumeAll}>Fortsetzen</Button>
				</div>
			{/if}
			{#if shell.focus}
				<p class="focus">
					Fokus <ProjectTag code={shell.focus.code} palette={shell.focus.palette} />
					{shell.focus.name}
					<button
						class="btn btn-ghost btn-icon"
						aria-label="Projekt-Fokus aufheben"
						onclick={() => (shell.focus = null)}><Icon name="x" size={14} /></button
					>
				</p>
			{/if}
			{@render children()}
			<footer class="page-end">{@render attribution()}</footer>
		</main>

		<AppBar {openCommandLine} openKeys={() => (keysOpen = true)} />
	</div>

	<Dialog variant="bar-sheet" bind:open={commandOpen} title="Befehlszeile">
		<CommandLine {sources} autofocus bind:value={commandValue} focused onexecute={execute} />
		<KeyHints hints={commandLineKeys} label="Tasten der Befehlszeile" />
	</Dialog>
	<KeyOverview bind:open={keysOpen} context={keyContextOf(path)} />
{/if}

<Toaster />

<style>
	/* The window scrolls under the sticky head and the fixed app bar: what the page scrolls into view (focus, anchors)
	   keeps clear of both. On the content only — as scroll-padding it would also scroll the page for the head's own
	   links, which sit in that very strip. */
	main :global(*) {
		scroll-margin-block: var(--head-h) calc(var(--appbar-h) + env(safe-area-inset-bottom));
	}
	.shell {
		min-height: 100dvh;
		background: var(--bg);
	}
	main {
		min-width: 0;
		padding: var(--space-6) var(--gutter)
			calc(var(--appbar-h) + env(safe-area-inset-bottom) + var(--space-6));
	}
	main:focus-visible {
		outline: none; /* target of the skip link, not a control */
		box-shadow: none;
	}
	.halt-banner,
	.focus {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-4);
	}
	.halt-banner {
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		border-radius: var(--radius-tile);
		background: var(--tile-warning);
		color: var(--text);
		font-weight: var(--weight-medium);
	}
	.halt-banner[data-tone='error'] {
		background: var(--tile-error);
	}
	.halt-banner [role='status'] {
		flex: 1;
	}
	.focus {
		color: var(--text-muted);
		font-size: var(--type-meta);
	}
	.page-end {
		margin-top: var(--space-8);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.attribution a {
		color: inherit;
		font-weight: 600;
	}
	.skip {
		position: fixed;
		top: var(--space-2);
		left: var(--space-2);
		z-index: 30;
		translate: 0 -200%;
	}
	.skip:focus {
		translate: 0 0;
	}

	.bare {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: center;
		justify-items: center;
		gap: var(--space-6);
		min-height: 100dvh;
		padding: var(--space-6) var(--space-4);
	}
	.bare .brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.bare main {
		display: grid;
		gap: var(--space-3);
		width: min(360px, 100%);
		padding: 0;
	}
	/* Login and setup forms: spacing between fields, label above its field, errors stand out */
	.bare main :global(form) {
		display: grid;
		gap: var(--space-3);
	}
	.bare main :global(label) {
		display: grid;
		gap: var(--space-1);
	}
	.bare main :global(form > button) {
		justify-self: start;
	}
	.bare main :global([role='alert']) {
		color: var(--status-failed);
		font-weight: 560;
	}
	.bare .attribution {
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-align: center;
	}
</style>
