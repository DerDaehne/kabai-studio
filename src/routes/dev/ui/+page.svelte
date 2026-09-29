<script lang="ts">
	import { page } from '$app/state';
	import Badge, { type Tone } from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import { toast } from '$lib/ui/toast.svelte';

	// Übersicht aller Bausteine zum Prüfen (nicht verlinkt). ?open=dialog|panel öffnet ein Overlay direkt.
	let dialogOpen = $state(page.url.searchParams.get('open') === 'dialog');
	let panelOpen = $state(page.url.searchParams.get('open') === 'panel');
	let saving = $state(false);
	let columnName = $state('Review');

	const scale = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
	const statuses: [Tone, string][] = [
		['running', 'läuft'],
		['waiting', 'wartet auf Freigabe'],
		['failed', 'fehlgeschlagen'],
		['succeeded', 'erledigt'],
		['paused', 'pausiert'],
		['neutral', 'in Warteschlange']
	];
	const runs: { key: string; title: string; tone: Tone; state: string; role: string; age: string }[] = [
		{ key: 'STU-41', title: 'Anmeldeseite an Design-System anpassen', tone: 'running', state: 'läuft', role: 'Developer', age: '2 min' },
		{ key: 'STU-38', title: 'Shell-Freigabe für npm install', tone: 'waiting', state: 'wartet auf Freigabe', role: 'Developer', age: '6 min' },
		{ key: 'STU-37', title: 'Migration 004: Anhänge', tone: 'failed', state: 'fehlgeschlagen', role: 'Developer', age: '14 min' },
		{ key: 'STU-35', title: 'Review: Workflow-Regeln der Domain-Schicht', tone: 'succeeded', state: 'erledigt', role: 'Reviewer', age: '31 min' },
		{ key: 'STU-33', title: 'Notes-Suche mit Snippets', tone: 'paused', state: 'pausiert', role: 'Developer', age: '1 h' },
		{ key: 'STU-30', title: 'Onboarding-Assistent: Modellwahl', tone: 'neutral', state: 'in Warteschlange', role: 'Refiner', age: '2 h' }
	];

	function save() {
		saving = true;
		setTimeout(() => {
			saving = false;
			dialogOpen = false;
			toast(`Spalte „${columnName}" umbenannt`, 'success');
		}, 900);
	}
</script>

<svelte:head><title>Komponenten – kabai studio</title></svelte:head>

<div class="page">
	<header>
		<h1>Komponenten</h1>
		<p class="muted">Tokens und Bausteine des Design-Systems im Überblick.</p>
	</header>

	<section aria-labelledby="h-colors">
		<h2 id="h-colors">Farben</h2>
		<div class="swatches" role="list" aria-label="Akzentskala Moos">
			{#each scale as step (step)}
				<div class="swatch" role="listitem">
					<span style:background="var(--green-{step})"></span>
					<code>{step}</code>
				</div>
			{/each}
		</div>
		<div class="row">
			{#each statuses as [tone, label] (tone)}<Badge {tone}>{label}</Badge>{/each}
			<Badge tone="accent">Epic</Badge>
		</div>
	</section>

	<section aria-labelledby="h-actions">
		<h2 id="h-actions">Aktionen</h2>
		<div class="row">
			<Button variant="primary">Run starten</Button>
			<Button>Freigeben</Button>
			<Button variant="ghost">Abbrechen</Button>
			<Button variant="danger">Ticket löschen</Button>
			<Button size="sm">Klein</Button>
			<Button variant="primary" loading>Speichert</Button>
			<Button disabled>Deaktiviert</Button>
		</div>
	</section>

	<section aria-labelledby="h-list">
		<h2 id="h-list">Liste (Dichte)</h2>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th scope="col">Ticket</th><th scope="col">Titel</th><th scope="col">Status</th><th scope="col">Rolle</th><th scope="col">Aktiv</th></tr>
				</thead>
				<tbody>
					{#each runs as run (run.key)}
						<tr>
							<td class="mono muted">{run.key}</td>
							<td class="title">{run.title}</td>
							<td><Badge tone={run.tone}>{run.state}</Badge></td>
							<td class="muted">{run.role}</td>
							<td class="mono muted">vor {run.age}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section aria-labelledby="h-form">
		<h2 id="h-form">Formular</h2>
		<div class="form">
			<FormField label="Titel" hint="Kurz und als Ergebnis formuliert.">
				{#snippet children(a)}<input {...a} value="Anmeldeseite an Design-System anpassen" />{/snippet}
			</FormField>
			<FormField label="Agent-Profil">
				{#snippet children(a)}
					<select {...a}><option>Developer</option><option>Reviewer</option><option>Refiner</option></select>
				{/snippet}
			</FormField>
			<FormField label="Endpoint" error="Keine Verbindung. Adresse prüfen oder den Server starten.">
				{#snippet children(a)}<input {...a} value="http://localhost:8080/v1" />{/snippet}
			</FormField>
			<FormField label="Rollen-Prompt" hint="Wird jedem Run in dieser Spalte vorangestellt.">
				{#snippet children(a)}<textarea {...a} rows="3" placeholder="Du bist Developer …"></textarea>{/snippet}
			</FormField>
		</div>
	</section>

	<section aria-labelledby="h-overlays">
		<h2 id="h-overlays">Überlagerungen und Meldungen</h2>
		<div class="row">
			<Button onclick={() => (dialogOpen = true)}>Dialog öffnen</Button>
			<Button onclick={() => (panelOpen = true)}>Seitenpanel öffnen</Button>
			<Button variant="ghost" onclick={() => toast('Run STU-41 gestartet')}>Info-Meldung</Button>
			<Button variant="ghost" onclick={() => toast('Ticket nach Review verschoben', 'success')}>Erfolg</Button>
			<Button variant="ghost" onclick={() => toast('Run STU-37 fehlgeschlagen: Migration bricht ab', 'error')}>Fehler</Button>
		</div>
	</section>

	<section aria-labelledby="h-empty">
		<h2 id="h-empty">Laden und Leere</h2>
		<div class="row"><Spinner /><span class="muted">Lädt Runs …</span></div>
		<EmptyState title="Keine offenen Fragen">
			Wenn ein Agent eine Frage stellt oder eine Freigabe braucht, erscheint sie hier.
			{#snippet action()}<Button size="sm">Zum Board</Button>{/snippet}
		</EmptyState>
	</section>
</div>

<Dialog bind:open={dialogOpen} title="Spalte umbenennen">
	<FormField label="Name">
		<!-- autofocus im Dialog ist gewollt: showModal() setzt den Anfangsfokus auf das Namensfeld statt auf „Schließen" -->
		<!-- svelte-ignore a11y_autofocus -->
		{#snippet children(a)}<input {...a} bind:value={columnName} autofocus />{/snippet}
	</FormField>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (dialogOpen = false)}>Abbrechen</Button>
		<Button variant="primary" loading={saving} onclick={save}>Speichern</Button>
	{/snippet}
</Dialog>

<Dialog bind:open={panelOpen} variant="panel" title="STU-41 Anmeldeseite an Design-System anpassen">
	<div class="detail">
		<div class="row"><Badge tone="running">läuft</Badge><span class="muted">Developer seit 2 min</span></div>
		<p>Formular auf FormField umstellen, Fehlermeldungen mit Ausweg, Tastaturbedienung prüfen.</p>
		<h3>Tasks</h3>
		<ul>
			<li><label><input type="checkbox" checked /> Felder nutzen FormField</label></li>
			<li><label><input type="checkbox" /> Fehlermeldung nennt den Ausweg</label></li>
			<li><label><input type="checkbox" /> Bei 375 px ohne horizontales Scrollen</label></li>
		</ul>
	</div>
</Dialog>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: 960px;
	}
	header {
		display: grid;
		gap: var(--space-1);
	}
	section {
		display: grid;
		gap: var(--space-3);
	}
	h2 {
		padding-bottom: var(--space-1);
		border-bottom: 1px solid var(--border);
		font-size: var(--text-base);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.swatches {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
		gap: var(--space-1);
	}
	.swatch {
		display: grid;
		gap: var(--space-05);
	}
	.swatch span {
		height: 28px;
		border-radius: var(--radius-sm);
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.06);
	}
	.swatch code {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		white-space: nowrap;
	}
	th {
		color: var(--text-muted);
		font-size: var(--text-sm);
		font-weight: 560;
		text-align: left;
	}
	th,
	td {
		height: 32px;
		padding: 0 var(--space-3) 0 0;
		border-bottom: 1px solid var(--border);
	}
	tbody tr:hover {
		background: var(--surface-hover);
	}
	td.title {
		width: 100%;
		font-weight: 520;
	}
	.form {
		display: grid;
		gap: var(--space-3);
		max-width: 420px;
	}
	.detail {
		display: grid;
		gap: var(--space-3);
	}
	.detail ul {
		display: grid;
		gap: var(--space-1);
		padding: 0;
		list-style: none;
	}
	.detail label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
