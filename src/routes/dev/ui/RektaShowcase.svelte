<script lang="ts">
	import HairlineList from '$lib/ui/rekta/HairlineList.svelte';
	import Progress from '$lib/ui/rekta/Progress.svelte';
	import Sparkline from '$lib/ui/rekta/Sparkline.svelte';
	import StatPair from '$lib/ui/rekta/StatPair.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import Tile from '$lib/ui/rekta/Tile.svelte';
	import { tones, type Tone } from '$lib/ui/rekta/tone';

	// The tile language of Rekta Design in every tone; the views take it over one by one.
	const words: Record<Tone, string> = {
		neutral: 'in warteschlange',
		info: 'läuft',
		success: 'fertig',
		warning: 'wartet',
		error: 'fehlgeschlagen'
	};
	const tokensPerMinute = [3, 5, 4, 8, 6, 9, 12, 10, 14];
	const runs: { key: string; title: string; tone: Tone; steps: number }[] = [
		{ key: 'STU-41', title: 'Anmeldeseite an Design-System anpassen', tone: 'info', steps: 42 },
		{ key: 'WEB-12', title: 'Shell-Freigabe für npm install', tone: 'warning', steps: 7 },
		{ key: 'API-7', title: 'Migration 004: Anhänge', tone: 'error', steps: 19 },
		{ key: 'STU-35', title: 'Review: Workflow-Regeln', tone: 'success', steps: 1204 }
	];
	let presses = $state(0);
</script>

<div class="showcase" data-testid="rekta-showcase">
	<p class="muted">
		Rekta Design: die Füllung ist der Zustand, die Größe die Bedeutung. Die Ansichten übernehmen die
		Bausteine nach und nach.
	</p>

	<div class="tiles">
		{#each tones as tone (tone)}
			<Tile {tone} href="#h-tiles">
				<Tag {tone}>{words[tone]}</Tag>
				<StatPair label="schritte" value={tone.length * 7} />
			</Tile>
		{/each}
		<Tile tone="info" size="2x1" onclick={() => presses++}>
			<StatPair label="tokens je minute" value={1234} unit="tok" />
			<Sparkline values={tokensPerMinute} label="tokens je minute" />
			<Progress value={3} max={8} label="kriterien" />
		</Tile>
		<Tile tone="warning" size="2x2">
			<Tag tone="warning">frage</Tag>
			<p class="question">Shell-Freigabe für npm install?</p>
			<p class="muted">Developer · STU-41 · seit 2 min</p>
			<div class="options">
				<button class="btn btn-sm" type="button">1 ja</button>
				<button class="btn btn-sm" type="button">2 nein</button>
			</div>
		</Tile>
	</div>
	<p class="muted" role="status">Knopf-Kachel gedrückt: {presses}</p>

	<div class="marks">
		{#each tones as tone (tone)}
			<div class="mark">
				<Tag {tone}>{words[tone]}</Tag>
				<Sparkline values={tokensPerMinute} label="schritte je minute ({tone})" {tone} />
				<Progress value={5} max={8} label="kriterien" format="percent" {tone} />
			</div>
		{/each}
		<div class="mark">
			<Tag>leer</Tag>
			<Sparkline values={[]} label="schritte je minute" />
			<Progress value={0} max={0} label="kriterien" />
		</div>
	</div>

	<HairlineList items={runs} label="Runs als Hairline-Zeilen">
		{#snippet row(run)}
			<div class="run">
				<span class="mono muted">{run.key}</span>
				<span class="title">{run.title}</span>
				<Tag tone={run.tone}>{words[run.tone]}</Tag>
				<StatPair label="schritte" value={run.steps} />
			</div>
		{/snippet}
	</HairlineList>
</div>

<style>
	.showcase {
		display: grid;
		gap: var(--space-4);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		grid-auto-rows: minmax(120px, auto);
		gap: var(--space-2);
	}
	.question {
		font-size: var(--type-item);
		font-weight: var(--weight-light);
	}
	.options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: auto;
	}
	.marks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: var(--space-4);
	}
	.mark {
		display: grid;
		gap: var(--space-2);
		align-content: start;
	}
	.run {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
	}
	.run .title {
		flex: 1 1 12rem;
		min-width: 0;
	}
</style>
