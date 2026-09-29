<script lang="ts">
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import Icon, { type IconName } from '$lib/ui/Icon.svelte';
	import Toaster from '$lib/ui/Toaster.svelte';

	let { children } = $props();

	const nav: { href: string; label: string; icon: IconName }[] = [
		{ href: '/', label: 'Projekte', icon: 'projects' },
		{ href: '/inbox', label: 'Inbox', icon: 'inbox' },
		{ href: '/notes', label: 'Notes', icon: 'notes' },
		{ href: '/settings', label: 'Einstellungen', icon: 'settings' }
	];
	const path: string = $derived(page.url.pathname);
	const bare = $derived(path === '/login' || path === '/setup'); // Anmeldung und Einrichtung ohne Navigation
	const isActive = (href: string) =>
		href === '/' ? path === '/' || path.startsWith('/projects') : path === href || path.startsWith(`${href}/`);

	// Farbschema: System (prefers-color-scheme) oder fest; app.html setzt den gespeicherten Wert vor dem ersten Paint.
	type Theme = 'system' | 'light' | 'dark';
	let theme = $state<Theme>('system');
	onMount(() => {
		theme = (document.documentElement.dataset.theme as Theme | undefined) ?? 'system';
	});
	function setTheme(value: Theme) {
		theme = value;
		const root = document.documentElement;
		if (value === 'system') delete root.dataset.theme;
		else root.dataset.theme = value;
		try {
			if (value === 'system') localStorage.removeItem('studio-theme');
			else localStorage.setItem('studio-theme', value);
		} catch {
			// ohne Speicher (privater Modus) gilt die Wahl nur bis zum Neuladen
		}
	}
</script>

<svelte:head>
	<title>kabai studio</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- Attribution nach LICENSE (Zusatzbedingung §7b): Originalprojekt und -autor bleiben sichtbar -->
{#snippet attribution()}
	<p class="attribution">
		<a href="https://github.com/DerDaehne/kabai-studio">kabai-studio</a> von DerDaehne<br />Freie Software, AGPL-3.0
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
		<div class="brand"><img src={favicon} alt="" width="20" height="20" />kabai studio</div>
		<nav aria-label="Hauptnavigation">
			<ul>
				{#each nav as item (item.href)}
					<li>
						<a href={item.href} aria-current={isActive(item.href) ? 'page' : undefined}>
							<Icon name={item.icon} /><span>{item.label}</span>
						</a>
					</li>
				{/each}
			</ul>
		</nav>
		<main id="main" tabindex="-1">{@render children()}</main>
		<footer class="foot">
			<label class="theme">
				Farbschema
				<select value={theme} onchange={(e) => setTheme(e.currentTarget.value as Theme)}>
					<option value="system">System</option>
					<option value="light">Hell</option>
					<option value="dark">Dunkel</option>
				</select>
			</label>
			{@render attribution()}
		</footer>
	</div>
{/if}

<Toaster />

<style>
	.shell {
		display: grid;
		grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		grid-template-rows: auto 1fr auto;
		grid-template-areas: 'brand main' 'nav main' 'foot main';
		height: 100dvh;
	}
	/* .brand und main gibt es in Shell und bare-Ansicht: Raster/Chrome nur über .shell > … */
	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.shell > .brand,
	nav,
	.foot {
		background: var(--bg-chrome);
		border-right: 1px solid var(--border);
	}
	.shell > .brand {
		grid-area: brand;
		height: 48px;
		padding: 0 var(--space-4);
	}
	nav {
		grid-area: nav;
		padding: var(--space-1) var(--space-2);
		overflow-y: auto;
	}
	nav ul {
		display: grid;
		gap: var(--space-05);
		padding: 0;
		list-style: none;
	}
	nav a {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: var(--control-h);
		padding: 0 var(--space-2);
		border-radius: var(--radius);
		color: var(--text-muted);
		font-weight: 560;
		text-decoration: none;
	}
	nav a:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	nav a[aria-current='page'] {
		background: var(--accent-tint);
		color: var(--accent-text);
	}
	.foot {
		grid-area: foot;
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4) var(--space-4);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.theme {
		display: grid;
		gap: var(--space-1);
	}
	.theme select {
		min-height: var(--control-h-sm);
		font-size: var(--text-sm);
	}
	.attribution {
		line-height: 1.4;
	}
	.attribution a {
		color: inherit;
		font-weight: 600;
	}
	.shell > main {
		grid-area: main;
		min-width: 0;
		overflow: auto;
		padding: var(--space-4) var(--space-6) var(--space-8);
	}
	main:focus-visible {
		outline: none; /* Ziel des Skip-Links, kein Bedienelement */
	}
	.skip {
		position: fixed;
		top: var(--space-2);
		left: var(--space-2);
		z-index: 10;
		translate: 0 -200%;
	}
	.skip:focus {
		translate: 0 0;
	}

	/* Handy/schmal: Marke oben, Navigation als Tab-Leiste unten (Daumenbereich), Fußzeile am Seitenende */
	@media (max-width: 719px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'brand' 'main' 'foot';
			height: auto;
			min-height: 100dvh;
			padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
		}
		.shell > .brand,
		.foot {
			border-right: 0;
		}
		.shell > .brand {
			height: 44px;
			border-bottom: 1px solid var(--border);
		}
		.foot {
			border-top: 1px solid var(--border);
		}
		.shell > main {
			overflow: visible;
			padding: var(--space-3);
		}
		nav {
			position: fixed;
			inset: auto 0 0;
			z-index: 5;
			padding: 0 0 env(safe-area-inset-bottom);
			border-right: 0;
			border-top: 1px solid var(--border);
		}
		nav ul {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 0;
		}
		nav a {
			flex-direction: column;
			justify-content: center;
			gap: 3px;
			height: var(--tabbar-h);
			border-radius: 0;
			font-size: var(--text-sm);
		}
		nav a[aria-current='page'] {
			background: transparent;
			box-shadow: inset 0 2px 0 var(--accent);
		}
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
