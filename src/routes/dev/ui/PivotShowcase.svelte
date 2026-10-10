<script lang="ts">
	import Pivot, { type Facet } from '$lib/ui/Pivot.svelte';
	import HairlineList from '$lib/ui/rekta/HairlineList.svelte';
	import Tag from '$lib/ui/rekta/Tag.svelte';
	import type { Tone } from '$lib/ui/rekta/tone';

	// Takt's facets with made-up runs; "fertig" is long enough to scroll inside itself in the panorama.
	type Run = { key: string; title: string };
	const runsOf = (prefix: string, count: number, title: string): Run[] =>
		Array.from({ length: count }, (_, index) => ({
			key: `${prefix}-${index + 1}`,
			title: `${title} ${index + 1}`
		}));
	const runs: Record<string, { tone: Tone; word: string; runs: Run[] }> = {
		fragen: { tone: 'warning', word: 'frage', runs: runsOf('STU', 2, 'Shell-Freigabe') },
		laeuft: { tone: 'info', word: 'läuft', runs: runsOf('WEB', 3, 'Anmeldeseite') },
		angehalten: { tone: 'warning', word: 'angehalten', runs: runsOf('API', 1, 'Migration') },
		fertig: { tone: 'success', word: 'fertig', runs: runsOf('DOC', 40, 'Notes-Suche') }
	};
	const facets: Facet[] = [
		{ id: 'fragen', label: 'Fragen', count: 2, width: '560px' },
		{ id: 'laeuft', label: 'Läuft', count: 3, width: '460px' },
		{ id: 'angehalten', label: 'Angehalten', count: 1 },
		{ id: 'fertig', label: 'Fertig', count: 40, width: '480px' }
	];
	let active = $state('fragen');
	let reported = $state<string[]>([]);
</script>

<div class="showcase" data-testid="pivot-showcase">
	<p class="muted">
		Facetten am selben Ort: ← → oder h/l wechseln, ab 1300 px stehen sie nebeneinander und das
		Mausrad scrollt seitwärts.
	</p>
	<div class="outside">
		<label>
			Facette von außen
			<select bind:value={active}>
				{#each facets as facet (facet.id)}<option value={facet.id}>{facet.label}</option>{/each}
			</select>
		</label>
		<p class="muted" role="status">Gemeldete Wechsel: {reported.join(', ') || 'keine'}</p>
	</div>
	<Pivot {facets} bind:active onchange={(id) => reported.push(id)} label="Takt-Facetten">
		{#snippet panel(facet)}
			{@const group = runs[facet.id]}
			<HairlineList items={group.runs} label="Runs: {facet.label}">
				{#snippet row(run)}
					<div class="run">
						<span class="mono muted">{run.key}</span>
						<span>{run.title}</span>
						<Tag tone={group.tone}>{group.word}</Tag>
					</div>
				{/snippet}
			</HairlineList>
		{/snippet}
	</Pivot>
</div>

<style>
	.showcase {
		display: grid;
		gap: var(--space-4);
	}
	.outside {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-6);
	}
	label {
		display: grid;
		gap: var(--space-1);
	}
	.run {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
	}
</style>
