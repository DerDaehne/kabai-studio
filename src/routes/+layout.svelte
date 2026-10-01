<script lang="ts">
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';
	import { goto, onNavigate, pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import favicon from '$lib/assets/favicon.svg';
	import CommandLine from '$lib/shell/CommandLine.svelte';
	import { commands, type Suggestion } from '$lib/shell/commands';
	import { contextLabels, validKeys, type KeyContext } from '$lib/shell/keys';
	import { shell } from '$lib/shell/shell.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import Icon, { type IconName } from '$lib/ui/Icon.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { transitionPage } from '$lib/ui/motion';
	import Nebula from '$lib/ui/Nebula.svelte';
	import ProjectTag from '$lib/ui/ProjectTag.svelte';
	import Toaster from '$lib/ui/Toaster.svelte';

	let { children } = $props();

	const views: { href: string; label: string; icon: IconName; context: KeyContext }[] = [
		{ href: '/', label: 'Stellwerk', icon: 'projects', context: 'stellwerk' },
		{ href: '/takt', label: 'Takt', icon: 'inbox', context: 'takt' },
		{ href: '/board', label: 'Board', icon: 'notes', context: 'board' }
	];
	const path: string = $derived(page.url.pathname);
	const bare = $derived(path === '/login' || path === '/setup');
	const currentView = $derived(views.find((view) => (view.href === '/' ? path === '/' : path.startsWith(view.href))));

	let commandValue = $state('');
	let commandInput = $state<HTMLInputElement>();
	let commandFocused = $state(false);
	const keyContext: KeyContext = $derived(commandFocused ? 'commandline' : (currentView?.context ?? 'page'));
	const keyBar = $derived(validKeys(keyContext, shell.pendingKeys));
	const sources = $derived({ commands, view: shell.viewItems, tickets: shell.tickets });

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

	function onWindowKeydown(event: KeyboardEvent) {
		if ((event.key !== ':' && event.key !== '/') || event.ctrlKey || event.metaKey || event.altKey) return;
		if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
		event.preventDefault();
		openCommandLine(event.key);
	}

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
		if (suggestion.href) await goto(suggestion.href);
		else if (suggestion.id === 'fokus-aus') shell.focus = null;
		else if (preferences[suggestion.id]) storePreference(preferences[suggestion.id]);
	}

	const waitingAgents = $derived(shell.agents.filter((agent) => agent.state === 'waiting').length);
	// a narrow head dock fits only one chip, and a second one would hide whether an agent waits
	const groupAgents = $derived(shell.agents.length >= (compact.current ? 2 : 3));

	onNavigate(transitionPage);
</script>

<svelte:head>
	<title>kabai studio</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

<!-- Attribution nach LICENSE (Zusatzbedingung §7b): Originalprojekt und -autor bleiben sichtbar -->
{#snippet attribution()}
	<p class="attribution">
		<a href="https://github.com/DerDaehne/kabai-studio">kabai-studio</a> von DerDaehne · Freie Software, AGPL-3.0
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
			<a class="brand" href="/" aria-label="kabai studio, Stellwerk"><img src={favicon} alt="" width="18" height="18" /></a>
			<nav class="views" aria-label="Ansichten">
				{#each views as view (view.href)}
					<a href={view.href} aria-current={view === currentView ? 'page' : undefined}>{view.label}</a>
				{/each}
			</nav>
			{#if shell.focus}
				<span class="chip focus-chip">
					Fokus <ProjectTag code={shell.focus.code} palette={shell.focus.palette} />
					<span class="focus-name">{shell.focus.name}</span>
					<button class="clear" aria-label="Projekt-Fokus aufheben" onclick={() => (shell.focus = null)}>
						<Icon name="x" size={14} />
					</button>
				</span>
			{/if}
			<ul class="agents" aria-label="Agents">
				{#if groupAgents}
					<li class="chip" class:halt={waitingAgents > 0}>
						<span class="dot" aria-hidden="true"></span>{shell.agents.length} Agents
						{#if waitingAgents}<span class="state">· {waitingAgents} {waitingAgents === 1 ? 'hält' : 'halten'}</span>{/if}
					</li>
				{:else}
					{#each shell.agents as agent (agent.name)}
						<li class="chip" class:halt={agent.state === 'waiting'}>
							<span class="dot" aria-hidden="true"></span>{agent.name}
							<span class="muted">{agent.location}</span>
							<ProjectTag code={agent.project.code} palette={agent.project.palette} />
							<span class="state">{agent.state === 'waiting' ? 'hält' : 'arbeitet'}</span>
						</li>
					{/each}
				{/if}
			</ul>
			<a class="btn btn-ghost btn-icon" href="/settings" aria-label="Einstellungen"><Icon name="settings" /></a>
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
				{#if keyBar.count || keyBar.prefix}
					<li class="pending">
						{#each [...keyBar.count, ...keyBar.prefix] as key, index (index)}<Kbd {key} active />{/each}
					</li>
				{/if}
				{#each keyBar.hints as hint (hint.label)}
					<li>
						{#each hint.keys as sequence, index (index)}
							{#each sequence as key, position (position)}<Kbd {key} />{/each}
						{/each}
						<span>{hint.label}</span>
					</li>
				{/each}
			</ul>
			{@render attribution()}
		</footer>

		<nav class="tabs dock" aria-label="Ansichten">
			{#each views as view (view.href)}
				<a href={view.href} aria-current={view === currentView ? 'page' : undefined}><Icon name={view.icon} />{view.label}</a>
			{/each}
			<button type="button" onclick={() => openCommandLine('')}><span class="glyph" aria-hidden="true">:/</span>Befehl</button>
		</nav>
	</div>

	<Dialog bind:open={() => overlayOpen, (open) => !open && closeOverlay()} title="Befehlszeile">
		<CommandLine {sources} autofocus bind:value={commandValue} focused onexecute={execute} />
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
		outline: none; /* Ziel des Skip-Links, kein Bedienelement */
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
	/* Formulare der Anmelde-/Einrichtungsseiten: Abstand zwischen Feldern, Label über dem Feld, Fehler hervorgehoben */
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
