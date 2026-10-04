<script lang="ts">
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';
	import { goto, onNavigate, pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import favicon from '$lib/assets/favicon.svg';
	import CommandLine from '$lib/shell/CommandLine.svelte';
	import {
		commands,
		focusCommands,
		focusTarget,
		resumeCommands,
		resumeTarget,
		withViewCommands,
		type Suggestion
	} from '$lib/shell/commands';
	import { pauseAll, resumeAll, resumeRun, stopAll } from '$lib/shell/halt';
	import { focusKeys, projectForLetter } from '$lib/shell/focus';
	import KeyOverview from '$lib/shell/KeyOverview.svelte';
	import { anyLetter, contextLabels, validKeys, type KeyContext } from '$lib/shell/keys';
	import {
		connectLive,
		gateLiveInvalidation,
		haltLabel,
		invalidateLive,
		live,
		openQuestionsLabel,
		pauseQuestion,
		showLive,
		stopQuestion
	} from '$lib/shell/live.svelte';
	import {
		bindKeys,
		boundActions,
		handleKey,
		keyboard,
		readKey,
		restoreSingleKeys,
		setSingleKeys
	} from '$lib/shell/router.svelte';
	import { shell } from '$lib/shell/shell.svelte';
	import { undoStack, type Undoable } from '$lib/shell/undo.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import Icon, { type IconName } from '$lib/ui/Icon.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { transitionPage } from '$lib/ui/motion';
	import Nebula from '$lib/ui/Nebula.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Toaster from '$lib/ui/Toaster.svelte';
	import { toast } from '$lib/ui/toast.svelte';

	let { data, children } = $props();

	type View = { href: string; label: string; icon: IconName; context: KeyContext };
	const views: View[] = [
		{ href: '/', label: 'Stellwerk', icon: 'projects', context: 'stellwerk' },
		{ href: '/takt', label: 'Takt', icon: 'inbox', context: 'takt' },
		{ href: '/board', label: 'Board', icon: 'notes', context: 'board' }
	];
	const path: string = $derived(page.url.pathname);
	const bare = $derived(path === '/login' || path === '/setup');
	const currentView = $derived(
		views.find((view) => (view.href === '/' ? path === '/' : path.startsWith(view.href)))
	);
	// The Run-Akte (/p/<key>/t/<n>) is a deep link, not one of the top-nav views above.
	const onTicketPage = $derived(/^\/p\/[^/]+\/t\/\d+/.test(path));

	let commandValue = $state('');
	let commandInput = $state<HTMLInputElement>();
	let commandFocused = $state(false);
	const keyContext: KeyContext = $derived(
		commandFocused ? 'commandline' : (currentView?.context ?? (onTicketPage ? 'ticket' : 'page'))
	);
	const keyBar = $derived(validKeys(keyContext, shell.pendingKeys, boundActions()));
	const haltedRuns = $derived(live.runs.filter((run) => run.state === 'paused'));
	const sources = $derived({
		commands: [
			...withViewCommands(shell.viewCommands, commands),
			...focusCommands(live.projects),
			...resumeCommands(haltedRuns, commandValue)
		],
		view: shell.viewItems,
		tickets: shell.tickets
	});

	const compact = new MediaQuery('max-width: 719px');
	const overlayOpen = $derived(page.state.commandLine === true);

	function openCommandLine(mode: string) {
		commandValue = mode;
		if (compact.current) {
			if (!overlayOpen) pushState('', { commandLine: true });
		} else {
			commandInput?.focus();
		}
	}

	/** The overlay is a history entry, so the back gesture closes it like Escape or a tap outside. */
	async function closeOverlay() {
		if (!page.state.commandLine) return;
		const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
		history.back();
		await popped;
	}

	let keysOpen = $state(false);

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
	// key bar would offer a key that does nothing
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

	async function execute(suggestion: Suggestion) {
		await closeOverlay();
		commandInput?.blur();
		const focusCommand = focusTarget(suggestion, live.projects);
		const resume = resumeTarget(suggestion);
		if (suggestion.run) suggestion.run();
		else if (suggestion.href) await goto(suggestion.href);
		else if (focusCommand !== undefined) shell.focus = focusCommand;
		else if (preferences[suggestion.id]) storePreference(preferences[suggestion.id]);
		else if (suggestion.id.startsWith('single-keys'))
			setSingleKeys(suggestion.id === 'single-keys-on');
		else if (suggestion.id === 'stop' || suggestion.id === 'pause') confirming = suggestion.id;
		else if (suggestion.id === 'resume') askWhichRun();
		else if (resume === 'all') await resumeAll();
		else if (resume !== undefined) await resumeRun(resume);
		else if (suggestion.id === 'run')
			toast(':run startet einen Run in der Run-Akte eines Tickets — öffne zuerst das Ticket.');
	}

	/** Outside the Run-Akte `:fortsetzen` alone does not say which run; the command line then offers the halted ones. */
	function askWhichRun() {
		toast(
			haltedRuns.length
				? 'Welchen Run? :fortsetzen N setzt einen angehaltenen fort, :fortsetzen all alle.'
				: 'Gerade ist kein Run angehalten; :fortsetzen all löst einen Halt.'
		);
		openCommandLine(':fortsetzen ');
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
	function onWindowKey(event: KeyboardEvent) {
		if (confirming && readKey(event) === 'y') {
			event.preventDefault();
			void confirm();
		} else handleKey(event);
	}

	const waitingAgents = $derived(shell.agents.filter((agent) => agent.state === 'waiting').length);
	// a narrow head dock fits only one chip, and a second one would hide whether an agent waits
	const groupAgents = $derived(shell.agents.length >= (compact.current ? 2 : 3));

	gateLiveInvalidation();
	onNavigate(transitionPage);

	const openQuestionsOf = (view: View) => (view.context === 'takt' ? live.openQuestions : 0);
	// a bare number would be read out as "Takt 2"; with a count the link's name says what is counted
	const accessibleViewName = (view: View) =>
		openQuestionsOf(view)
			? `${view.label}, ${openQuestionsLabel(openQuestionsOf(view))}`
			: undefined;

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

<svelte:window onkeydown={onWindowKey} />

{#snippet viewLabel(view: View)}
	{view.label}
	{#if openQuestionsOf(view)}<span class="count">{openQuestionsOf(view)}</span>{/if}
{/snippet}

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
		<Nebula />
		<a class="skip btn" href="#main">Zum Inhalt springen</a>

		<header class="head dock">
			<a class="brand" href="/" aria-label="kabai studio, Stellwerk"
				><img src={favicon} alt="" width="18" height="18" /></a
			>
			<nav class="views" aria-label="Ansichten">
				{#each views as view (view.href)}
					<a
						href={view.href}
						aria-current={view === currentView ? 'page' : undefined}
						aria-label={accessibleViewName(view)}>{@render viewLabel(view)}</a
					>
				{/each}
			</nav>
			{#if shell.focus}
				<span class="chip focus-chip">
					Fokus <ProjectTag code={shell.focus.code} palette={shell.focus.palette} />
					<span class="focus-name">{shell.focus.name}</span>
					<button
						class="clear"
						aria-label="Projekt-Fokus aufheben"
						onclick={() => (shell.focus = null)}
					>
						<Icon name="x" size={14} />
					</button>
				</span>
			{/if}
			{#if live.halt}
				<div class="chip halted">
					<Icon name={live.halt === 'stop' ? 'stop' : 'pause'} size={14} />
					<span role="status">{haltLabel(live.halt, live.runs)}</span>
					<Button size="sm" onclick={resumeAll}>Fortsetzen</Button>
				</div>
			{/if}
			<ul class="agents" aria-label="Agents">
				{#if groupAgents}
					<li class="chip" class:halt={waitingAgents > 0}>
						<span class="dot" aria-hidden="true"></span>{shell.agents.length} Agents
						{#if waitingAgents}<span class="state"
								>· {waitingAgents} {waitingAgents === 1 ? 'hält' : 'halten'}</span
							>{/if}
					</li>
				{:else}
					{#each shell.agents as agent (agent.id)}
						<li class="chip" class:halt={agent.state === 'waiting'}>
							<span class="dot" aria-hidden="true"></span>{agent.name}
							<span class="muted">{agent.location}</span>
							<ProjectTag code={agent.project.code} palette={agent.project.palette} />
							<span class="state">{agent.state === 'waiting' ? 'hält' : 'arbeitet'}</span>
						</li>
					{/each}
				{/if}
			</ul>
			<a class="btn btn-ghost btn-icon settings" href="/settings" aria-label="Einstellungen"
				><Icon name="settings" /></a
			>
			{#key shell.signals}
				{#if shell.signals}<span class="wave" aria-hidden="true"></span>{/if}
			{/key}
		</header>

		<main id="main" tabindex="-1">
			{@render children()}
			<footer class="page-end">{@render attribution()}</footer>
		</main>

		<footer class="commands dock">
			<CommandLine
				{sources}
				floating
				bind:value={commandValue}
				bind:input={commandInput}
				bind:focused={commandFocused}
				onexecute={execute}
				onescape={() => commandInput?.blur()}
			/>
			<p class="context"><strong>{contextLabels[keyContext]}</strong></p>
			<ul class="keys" aria-label="Gültige Tasten">
				{#if !keyboard.singleKeys}
					<li><span>nur mit</span><Kbd key="Alt" /></li>
				{/if}
				{#if keyBar.count || keyBar.prefix}
					<li class="pending">
						{#each [...keyBar.count, ...keyBar.prefix] as key, index (index)}<Kbd
								{key}
								active
							/>{/each}
						<Kbd key="Escape" /><span>abbrechen</span>
					</li>
				{/if}
				{#each keyBar.hints as hint (hint.label)}
					<li>
						{#if hint.keys[0]?.includes(anyLetter)}
							<Kbd key={hint.keys[0][0]} />
							{#each focusKeys(live.projects) as { letter } (letter)}<Kbd key={letter} />{/each}
						{:else}
							{#each hint.keys as sequence, index (index)}
								{#each sequence as key, position (position)}<Kbd {key} />{/each}
							{/each}
						{/if}
						<span>{hint.label}</span>
					</li>
				{/each}
			</ul>
			{@render attribution()}
		</footer>

		<nav class="tabs dock" aria-label="Ansichten">
			{#each views as view (view.href)}
				<a
					href={view.href}
					aria-current={view === currentView ? 'page' : undefined}
					aria-label={accessibleViewName(view)}
					><Icon name={view.icon} />{@render viewLabel(view)}</a
				>
			{/each}
			<button type="button" onclick={() => openCommandLine('')}
				><span class="glyph" aria-hidden="true">:/</span>Befehl</button
			>
		</nav>
	</div>

	<Dialog bind:open={() => overlayOpen, (open) => !open && closeOverlay()} title="Befehlszeile">
		<CommandLine {sources} autofocus bind:value={commandValue} focused onexecute={execute} />
	</Dialog>
	<KeyOverview bind:open={keysOpen} />
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
{/if}

<Toaster />

<style>
	.shell {
		position: relative;
		isolation: isolate;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		height: 100dvh;
		background: var(--bg);
	}
	.dock {
		background: var(--glass-float);
		backdrop-filter: blur(var(--blur-float)) saturate(var(--glass-sat));
		box-shadow: var(--shadow-float);
	}
	.head {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		margin: var(--space-3) var(--space-3) 0;
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		border-radius: 18px;
		overflow: hidden;
		view-transition-name: head-dock;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.head .brand {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border-radius: 11px;
		background: var(--accent-tint);
	}
	.views {
		display: flex;
		gap: var(--space-05);
		padding: 3px;
		border-radius: 12px;
		background: var(--fill-soft);
	}
	.views a {
		padding: var(--space-1) var(--space-3);
		border-radius: 9px;
		color: var(--text-muted);
		font-weight: 560;
		text-decoration: none;
	}
	.views a:hover {
		color: var(--text);
	}
	.count {
		display: inline-block;
		min-width: 18px;
		margin-left: 6px;
		padding: 0 5px;
		border-radius: 9px;
		background: var(--status-waiting-tint);
		color: var(--status-waiting);
		font: 700 12px / 18px var(--font-mono);
		text-align: center;
	}
	.views a[aria-current='page'] {
		background: var(--glass-raised);
		box-shadow: var(--shadow-card);
		color: var(--text);
	}
	.agents {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		list-style: none;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 var(--space-3) 0 10px;
		border-radius: 15px;
		background: var(--fill-soft);
		font-size: var(--text-sm);
		white-space: nowrap;
	}
	.chip .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--status-running);
	}
	.chip .state {
		color: var(--status-running);
	}
	.chip.halt .dot {
		background: var(--status-waiting);
	}
	.chip.halt .state {
		color: var(--status-waiting);
	}
	/* The kill switch stays visible until it is released: it never shrinks away like the agent chips */
	.halted {
		flex-shrink: 0;
		height: auto;
		min-height: 30px;
		padding-right: 3px;
		background: var(--status-paused-tint);
		box-shadow: 0 0 16px var(--aura-paused);
		color: var(--status-paused);
		font-weight: 560;
	}
	.settings {
		flex-shrink: 0;
	}
	.focus-chip {
		flex-shrink: 0;
		padding-right: var(--space-1);
		background: var(--fill-sel);
	}
	.clear {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
	}
	.wave {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.wave::before {
		content: '';
		position: absolute;
		inset: 0;
		width: 30%;
		background: linear-gradient(90deg, transparent, var(--aura-waiting), transparent);
		transform: translateX(-100%);
		animation: wave var(--dur-sweep) var(--ease-inout) both;
	}
	@keyframes wave {
		to {
			transform: translateX(400%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.wave {
			display: none;
		}
	}
	:global(:root[data-motion='reduced']) .wave {
		display: none;
	}

	main {
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: var(--space-6) var(--space-6) var(--space-4);
		scroll-padding-block: var(--space-6);
	}
	main:focus-visible {
		outline: none; /* target of the skip link, not a control */
		box-shadow: none;
	}
	.page-end {
		display: none;
		margin-top: var(--space-8);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.commands {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-width: 0;
		margin: 0 var(--space-3) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: 18px;
		view-transition-name: command-dock;
	}
	.commands > :global(.commandline) {
		flex: 0 0 260px;
	}
	.context {
		flex-shrink: 0;
		font-size: var(--text-sm);
	}
	.keys {
		/* contains the hidden key names of Kbd (position: absolute), so the clipped keys cannot widen the page */
		position: relative;
		display: flex;
		gap: var(--space-3);
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		list-style: none;
		font-size: var(--text-sm);
		white-space: nowrap;
	}
	.keys li {
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.keys span {
		margin-left: 3px;
		color: var(--text-muted);
	}
	.commands .attribution {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.attribution a {
		color: inherit;
		font-weight: 600;
	}

	.tabs {
		display: none;
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

	/* Phones: views and the command line move to a tab dock in thumb reach, the attribution to the end of the content */
	@media (max-width: 719px) {
		.head {
			margin: var(--space-2) var(--space-2) 0;
		}
		.head .views,
		.commands,
		.agents .muted {
			display: none;
		}
		.agents {
			justify-content: flex-start;
		}
		/* too narrow for the whole label on one line: it wraps instead of pushing the settings out of the dock */
		.halted {
			flex-shrink: 1;
			min-width: 0;
			line-height: 1.2;
			white-space: normal;
		}
		.halted > :global(svg),
		.halted :global(.btn) {
			flex-shrink: 0;
			white-space: nowrap;
		}
		main {
			padding: var(--space-4) var(--space-3);
		}
		.page-end {
			display: block;
		}
		.tabs {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			margin: 0 var(--space-2) calc(var(--space-2) + env(safe-area-inset-bottom));
			border-radius: 18px;
			view-transition-name: command-dock;
		}
		.tabs a,
		.tabs button {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 3px;
			height: var(--tabbar-h);
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--text-muted);
			font-size: var(--text-sm);
			text-decoration: none;
		}
		.tabs a[aria-current='page'] {
			color: var(--accent-text);
		}
		.tabs a {
			position: relative;
		}
		.tabs .count {
			position: absolute;
			top: 6px;
			left: calc(50% + 6px);
			margin: 0;
		}
		.glyph {
			font: 700 15px / 16px var(--font-mono);
		}
	}

	:global(::view-transition-group(head-dock)),
	:global(::view-transition-group(command-dock)) {
		animation: none;
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
		font-size: var(--text-lg);
	}
	.bare main {
		display: grid;
		gap: var(--space-3);
		width: min(360px, 100%);
		overflow: visible;
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
