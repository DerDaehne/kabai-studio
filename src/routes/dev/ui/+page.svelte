<script lang="ts">
	import { page } from '$app/state';
	import { assignAurae, type AuraCandidate } from '$lib/ui/aura';
	import AuraList from '$lib/ui/AuraList.svelte';
	import Badge, { type Tone } from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import FormField from '$lib/ui/FormField.svelte';
	import Kbd from '$lib/ui/Kbd.svelte';
	import { tilt, travel } from '$lib/ui/motion';
	import Nebula from '$lib/ui/Nebula.svelte';
	import ProjectTag, { type ProjectPalette } from '$lib/ui/ProjectTag.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import { toast } from '$lib/ui/toast.svelte';
	import { agentChips, live } from '$lib/shell/live.svelte';
	import { bindKeys } from '$lib/shell/router.svelte';
	import { announceSignal, shell, type AgentChip } from '$lib/shell/shell.svelte';
	import { undoStack } from '$lib/shell/undo.svelte';

	// An overview of all building blocks for checking them (not linked). ?open=dialog|panel opens an overlay directly.
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
	const runs: {
		key: string;
		title: string;
		tone: Tone;
		state: string;
		role: string;
		age: string;
	}[] = [
		{
			key: 'STU-41',
			title: 'Anmeldeseite an Design-System anpassen',
			tone: 'running',
			state: 'läuft',
			role: 'Developer',
			age: '2 min'
		},
		{
			key: 'STU-38',
			title: 'Shell-Freigabe für npm install',
			tone: 'waiting',
			state: 'wartet auf Freigabe',
			role: 'Developer',
			age: '6 min'
		},
		{
			key: 'STU-37',
			title: 'Migration 004: Anhänge',
			tone: 'failed',
			state: 'fehlgeschlagen',
			role: 'Developer',
			age: '14 min'
		},
		{
			key: 'STU-35',
			title: 'Review: Workflow-Regeln der Domain-Schicht',
			tone: 'succeeded',
			state: 'erledigt',
			role: 'Reviewer',
			age: '31 min'
		},
		{
			key: 'STU-33',
			title: 'Notes-Suche mit Snippets',
			tone: 'paused',
			state: 'pausiert',
			role: 'Developer',
			age: '1 h'
		},
		{
			key: 'STU-30',
			title: 'Onboarding-Assistent: Modellwahl',
			tone: 'neutral',
			state: 'in Warteschlange',
			role: 'Refiner',
			age: '2 h'
		}
	];

	const projects: { code: string; palette: ProjectPalette }[] = [
		{ code: 'STU', palette: 1 },
		{ code: 'WEB', palette: 2 },
		{ code: 'API', palette: 3 },
		{ code: 'DOC', palette: 4 },
		{ code: 'OPS', palette: 5 }
	];

	type Lane = AuraCandidate & {
		project: ProjectPalette;
		code: string;
		ticket: string;
		title: string;
		state: string;
		badge: Tone;
	};
	const lanes: Lane[] = [
		{
			key: 'STU-41',
			code: 'STU',
			project: 1,
			ticket: '41',
			title: 'Anmeldeseite an Design-System anpassen',
			tone: 'running',
			badge: 'running',
			state: 'läuft'
		},
		{
			key: 'WEB-12',
			code: 'WEB',
			project: 2,
			ticket: '12',
			title: 'Shell-Freigabe für npm install',
			tone: 'waiting',
			badge: 'waiting',
			state: 'wartet auf Freigabe'
		},
		{
			key: 'API-7',
			code: 'API',
			project: 3,
			ticket: '7',
			title: 'Migration 004: Anhänge',
			tone: 'failed',
			badge: 'failed',
			state: 'fehlgeschlagen'
		},
		{
			key: 'DOC-3',
			code: 'DOC',
			project: 4,
			ticket: '3',
			title: 'Handbuch: Einrichtung',
			tone: 'running',
			badge: 'running',
			state: 'läuft'
		},
		{
			key: 'OPS-9',
			code: 'OPS',
			project: 5,
			ticket: '9',
			title: 'Backup-Rotation prüfen',
			tone: 'paused',
			badge: 'paused',
			state: 'pausiert'
		},
		{
			key: 'STU-35',
			code: 'STU',
			project: 1,
			ticket: '35',
			title: 'Review: Workflow-Regeln',
			tone: 'succeeded',
			badge: 'succeeded',
			state: 'erledigt'
		}
	];
	let focusedLane = $state<string | undefined>(undefined);
	const aurae = $derived(
		assignAurae(lanes.map((lane) => ({ ...lane, focused: lane.key === focusedLane })))
	);
	function focusNextLane() {
		const next = lanes.findIndex((lane) => lane.key === focusedLane) + 1;
		focusedLane = lanes[next]?.key;
	}

	type GlassStrength = 'bold' | 'frosted' | 'solid';
	let glass = $state<GlassStrength>('bold');
	$effect(() => {
		const root = document.documentElement;
		if (glass === 'bold') delete root.dataset.glass;
		else root.dataset.glass = glass;
		return () => delete root.dataset.glass;
	});

	const questions = [
		'Shell-Freigabe für npm install?',
		'Migration 004 erneut starten?',
		'Review-Ergebnis von STU-35 abnehmen?'
	];
	let question = $state(0);
	let undoing = $state(false);
	let noteShown = $state(true);
	function advance(step: 1 | -1) {
		undoing = step < 0;
		question = (question + step + questions.length) % questions.length;
	}

	const demoAgents: AgentChip[] = [
		{
			id: 1,
			name: 'Claude',
			location: 'online',
			project: { id: 2, code: 'WEB', palette: 2, name: 'Webseite' },
			state: 'running'
		},
		{
			id: 2,
			name: 'qwen3-coder',
			location: 'lokal',
			project: { id: 1, code: 'STU', palette: 1, name: 'kabai studio' },
			state: 'waiting'
		},
		{
			id: 3,
			name: 'gpt-oss',
			location: 'lokal',
			project: { id: 3, code: 'API', palette: 3, name: 'Schnittstelle' },
			state: 'running'
		}
	];
	let agentCount = $state(2);
	$effect(() => {
		shell.agents = demoAgents.slice(0, agentCount);
		shell.viewItems = lanes.map((lane) => ({
			id: lane.key,
			label: `${lane.key} ${lane.title}`,
			detail: lane.state,
			href: '#h-glass'
		}));
		return () => {
			shell.agents = agentChips(live.runs);
			shell.viewItems = [];
			shell.focus = null;
			shell.pendingKeys = '';
		};
	});

	// Live key demo: two undoable action kinds (delete, change column) and a decision that takes 1–3
	const columns = ['Ready', 'In Arbeit', 'Review'];
	const rows = $state([
		{ id: 'STU-51', title: 'Tasten-Router', column: 0 },
		{ id: 'STU-52', title: 'Rückgängig-Stapel', column: 1 },
		{ id: 'STU-53', title: 'Tastenübersicht', column: 0 },
		{ id: 'STU-54', title: 'Einzeltasten aus', column: 2 }
	]);
	let selected = $state(0);
	let decisionInFocus = $state(false);
	let answer = $state('');

	const select = (index: number) => (selected = Math.max(0, Math.min(rows.length - 1, index)));

	function removeSelected() {
		const index = selected;
		const row = rows[index];
		if (!row) return;
		undoStack.perform({
			label: `${row.id} gelöscht`,
			perform: () => {
				rows.splice(index, 1);
				select(index);
			},
			revert: () => {
				rows.splice(index, 0, row);
				selected = index;
			}
		});
	}

	function shiftSelected(steps: number) {
		const row = rows[selected];
		if (!row) return;
		const from = row.column;
		const to = Math.max(0, Math.min(columns.length - 1, from + steps));
		if (to === from) return;
		undoStack.perform({
			label: `${row.id} nach ${columns[to]}`,
			perform: () => (row.column = to),
			revert: () => (row.column = from)
		});
	}

	$effect(() =>
		bindKeys({
			move: (count, key) => select(selected + (key === 'j' ? count : -count)),
			edge: (count, key) => select(key === 'G' ? rows.length - 1 : count - 1),
			remove: removeSelected,
			shiftColumn: (count, key) => shiftSelected(key === '>' ? count : -count),
			answer: decisionInFocus ? (_count, key) => (answer = `Antwort ${key}`) : undefined
		})
	);

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
		<div class="swatches" role="list" aria-label="Akzentskala Frühling">
			{#each scale as step (step)}
				<div class="swatch" role="listitem">
					<span style:background="var(--a-{step})"></span>
					<code>{step}</code>
				</div>
			{/each}
		</div>
		<div class="row">
			{#each statuses as [tone, label] (tone)}<Badge {tone}>{label}</Badge>{/each}
			<Badge tone="accent">Epic</Badge>
		</div>
		<div class="row" role="list" aria-label="Projektpalette">
			{#each projects as project (project.code)}<span role="listitem"
					><ProjectTag {...project} /></span
				>{/each}
		</div>
	</section>

	<section aria-labelledby="h-shell">
		<h2 id="h-shell">Shell</h2>
		<p class="muted">Füttert Kopf-Dock, Tastenleiste und Suche (/) mit Beispieldaten.</p>
		<div class="row">
			<Button variant="secondary" size="sm" onclick={() => (agentCount = agentCount === 2 ? 3 : 2)}
				>{agentCount === 2 ? '3 Agents' : '2 Agents'}</Button
			>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => (shell.focus = { id: 1, code: 'STU', palette: 1, name: 'kabai studio' })}
				>Projekt-Fokus</Button
			>
			<Button variant="secondary" size="sm" onclick={announceSignal}>Neues Signal</Button>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => (shell.pendingKeys = shell.pendingKeys ? '' : 'g')}>Präfix g</Button
			>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => (shell.pendingKeys = shell.pendingKeys ? '' : '3')}>Zähler 3</Button
			>
		</div>
	</section>

	<section aria-labelledby="h-keys">
		<h2 id="h-keys">Tasten</h2>
		<div class="row">
			<span><Kbd key="j" /> <Kbd key="k" /> wählen</span>
			<span><Kbd key="g" /> <Kbd key="g" /> zum Anfang</span>
			<span><Kbd key=" " /> <Kbd key="S" /> Projekt-Fokus</span>
			<span><Kbd key="1" /> <Kbd key="2" active /> <Kbd key="3" /> antworten</span>
			<span><Kbd key="Enter" /> öffnen</span>
			<span><Kbd key="Escape" /> zurück</span>
		</div>
		<p class="muted">
			Live: <Kbd key="j" /><Kbd key="k" /> mit Zähler, <Kbd key="g" /><Kbd key="g" />/<Kbd
				key="G"
			/>, <Kbd key="d" /><Kbd key="d" /> löschen, <Kbd key=">" /><Kbd key="<" /> Spalte,
			<Kbd key="u" /> und <Kbd key="Ctrl+r" />; <Kbd key="?" /> zeigt alle Tasten.
		</p>
		<label
			><input type="checkbox" bind:checked={decisionInFocus} /> Entscheidung im Fokus (<Kbd
				key="1"
			/>–<Kbd key="3" /> antworten)</label
		>
		<ol class="demo-rows" aria-label="Beispielzeilen">
			{#each rows as row, index (row.id)}
				<li aria-current={index === selected || undefined}>
					<span class="mono">{row.id}</span>
					{row.title}
					<Badge>{columns[row.column]}</Badge>
				</li>
			{/each}
		</ol>
		<p role="status">{answer}</p>
	</section>

	<section aria-labelledby="h-glass">
		<h2 id="h-glass">Glas und Auren</h2>
		<fieldset class="row">
			<legend>Glas-Stärke</legend>
			<label><input type="radio" name="glass" bind:group={glass} value="bold" /> Mutig</label>
			<label><input type="radio" name="glass" bind:group={glass} value="frosted" /> Milchglas</label
			>
			<label><input type="radio" name="glass" bind:group={glass} value="solid" /> Solide</label>
		</fieldset>
		<p class="muted">
			Eine starke Aura, höchstens zwei schwache; laufende Spuren nur in ihrer Projektfarbe.
			<Button size="sm" onclick={focusNextLane}>Fokus weiter</Button>
		</p>
		<div class="stage">
			<Nebula />
			<AuraList items={lanes} {aurae} label="Spuren">
				{#snippet item(lane)}
					<article
						class="lane glass"
						class:selected={lane.key === focusedLane}
						aria-current={lane.key === focusedLane || undefined}
					>
						<span class="mono"
							><ProjectTag code={lane.code} palette={lane.project} /> {lane.ticket}</span
						>
						<span class="title">{lane.title}</span>
						<Badge tone={lane.badge}>{lane.state}</Badge>
					</article>
				{/snippet}
			</AuraList>
			<div class="dock">
				<span><Kbd key="j" /> <Kbd key="k" /> wählen</span>
				<span><Kbd key=":" /> Befehl</span>
				<span><Kbd key="/" /> Suche</span>
			</div>
		</div>
	</section>

	<section aria-labelledby="h-motion">
		<h2 id="h-motion">Bewegung</h2>
		<p class="muted">
			Bei reduzierter Bewegung (System oder Einstellung in der Seitenleiste) nur Überblendung.
		</p>
		<div class="row">
			<Button onclick={() => advance(1)}>Weiterrücken</Button>
			<Button variant="ghost" onclick={() => advance(-1)}>Rückgängig</Button>
			<Button variant="ghost" onclick={() => (noteShown = !noteShown)}
				>Hinweis {noteShown ? 'ausblenden' : 'einblenden'}</Button
			>
		</div>
		<div class="queue">
			{#key question}
				<article class="decision" in:tilt={{ reverse: undoing }} out:tilt={{ reverse: undoing }}>
					<Badge tone="waiting">Frage {question + 1} von {questions.length}</Badge>
					<p>{questions[question]}</p>
					<div class="row">
						<span><Kbd key="1" /> Ja</span>
						<span><Kbd key="2" /> Nein</span>
						<span><Kbd key="3" /> Später</span>
					</div>
				</article>
			{/key}
		</div>
		{#if noteShown}<p class="note" transition:travel>
				Bewegung zeigt Herkunft und Ziel, der Zustand ändert sich sofort.
			</p>{/if}
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
					<tr
						><th scope="col">Ticket</th><th scope="col">Titel</th><th scope="col">Status</th><th
							scope="col">Rolle</th
						><th scope="col">Aktiv</th></tr
					>
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
				{#snippet children(a)}<input
						{...a}
						value="Anmeldeseite an Design-System anpassen"
					/>{/snippet}
			</FormField>
			<FormField label="Agent-Profil">
				{#snippet children(a)}
					<select {...a}
						><option>Developer</option><option>Reviewer</option><option>Refiner</option></select
					>
				{/snippet}
			</FormField>
			<FormField label="Endpoint" error="Keine Verbindung. Adresse prüfen oder den Server starten.">
				{#snippet children(a)}<input {...a} value="http://localhost:8080/v1" />{/snippet}
			</FormField>
			<FormField label="Rollen-Prompt" hint="Wird jedem Run in dieser Spalte vorangestellt.">
				{#snippet children(a)}<textarea {...a} rows="3" placeholder="Du bist Developer …"
					></textarea>{/snippet}
			</FormField>
		</div>
	</section>

	<section aria-labelledby="h-overlays">
		<h2 id="h-overlays">Überlagerungen und Meldungen</h2>
		<div class="row">
			<Button onclick={() => (dialogOpen = true)}>Dialog öffnen</Button>
			<Button onclick={() => (panelOpen = true)}>Seitenpanel öffnen</Button>
			<Button variant="ghost" onclick={() => toast('Run STU-41 gestartet')}>Info-Meldung</Button>
			<Button variant="ghost" onclick={() => toast('Ticket nach Review verschoben', 'success')}
				>Erfolg</Button
			>
			<Button
				variant="ghost"
				onclick={() => toast('Run STU-37 fehlgeschlagen: Migration bricht ab', 'error')}
				>Fehler</Button
			>
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
		<!-- autofocus in the dialog is intended: showModal() puts the initial focus on the name field instead of the close button -->
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
		<div class="row">
			<Badge tone="running">läuft</Badge><span class="muted">Developer seit 2 min</span>
		</div>
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
	.demo-rows {
		display: grid;
		gap: var(--space-1);
		margin: var(--space-3) 0;
		padding: 0;
		list-style: none;
	}
	.demo-rows li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius);
	}
	.demo-rows li[aria-current] {
		background: var(--fill-sel);
	}
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
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		float: left;
		margin-right: var(--space-2);
		font-weight: 560;
	}
	fieldset label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
	.stage {
		position: relative;
		isolation: isolate;
		display: grid;
		gap: var(--space-4);
		padding: var(--space-6) var(--space-4) var(--space-4);
		border-radius: var(--radius-xl);
		background: var(--bg);
		box-shadow: inset 0 0 0 1px var(--hairline);
		overflow: hidden;
	}
	.glass,
	.dock,
	.decision {
		border-radius: var(--radius-lg);
		backdrop-filter: blur(var(--blur-card)) saturate(var(--glass-sat));
	}
	.lane {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		background: var(--glass-card);
		box-shadow: var(--shadow-card);
	}
	.lane.selected {
		background: linear-gradient(var(--fill-sel), var(--fill-sel)), var(--glass-card);
	}
	.lane .title {
		overflow: hidden;
		font-weight: 520;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dock {
		display: flex;
		flex-wrap: wrap;
		justify-self: center;
		gap: var(--space-4);
		padding: var(--space-2) var(--space-4);
		background: var(--glass-float);
		backdrop-filter: blur(var(--blur-float)) saturate(var(--glass-sat));
		box-shadow: var(--shadow-float);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.queue {
		display: grid;
		max-width: 420px;
	}
	.decision {
		display: grid;
		grid-area: 1 / 1;
		gap: var(--space-2);
		padding: var(--space-4);
		background: var(--glass-raised);
		box-shadow: var(--shadow-float);
	}
	.decision p {
		font-size: var(--text-lg);
		font-weight: 600;
	}
	.note {
		color: var(--text-muted);
	}
	@media (max-width: 719px) {
		.lane {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.lane .title {
			grid-row: 2;
			grid-column: 1 / -1;
		}
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
