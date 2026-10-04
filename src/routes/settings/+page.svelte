<script lang="ts">
	import Badge from '$lib/ui/Badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const b = $derived(data.backup);
	const size = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`);
</script>

<h1>Einstellungen</h1>
<ul class="sections">
	<li>
		<a href="/settings/profiles">
			<span class="label">Agent-Profile</span>
			<span class="desc"
				>Mit welchem Modell Agents arbeiten: lokal oder online, vorbelegt aus dem Modell-Katalog.</span
			>
		</a>
	</li>
	<li>
		<a href="/settings/secrets">
			<span class="label">Secrets</span>
			<span class="desc"
				>API-Keys und Tokens für Agent-Profile und MCP-Server, verschlüsselt gespeichert.</span
			>
		</a>
	</li>
</ul>

<section class="backup" aria-labelledby="backup-title">
	<h2 id="backup-title">
		Sicherung <Badge tone={b.error ? 'failed' : 'succeeded'}
			>{b.error ? 'Problem' : 'aktuell'}</Badge
		>
	</h2>
	{#if b.error}<p class="error">{b.error}</p>{/if}
	<dl>
		<dt>Letzte Sicherung</dt>
		<dd>
			{#if b.last}<time datetime={b.last.at}>{b.last.at.slice(0, 16).replace('T', ' ')} UTC</time> · {size(
					b.last.size
				)}{:else}keine{/if}
		</dd>
		<dt>{b.last ? 'Datei' : 'Verzeichnis'}</dt>
		<dd><code>{b.last?.path ?? b.dir}</code></dd>
		<dt>Aufbewahrung</dt>
		<dd>
			täglich, dazu vor jedem Update; {data.retention.daily} tägliche + {data.retention.weekly} wöchentliche
		</dd>
	</dl>
	<p class="hint">
		Secrets stehen in der Sicherung nur verschlüsselt. <code>secret.key</code> aus dem
		Datenverzeichnis (bzw.
		<code>STUDIO_SECRET_KEY</code>) separat sichern — ohne ihn müssen Secrets nach einer
		Wiederherstellung neu eingegeben werden.
	</p>
	<p class="hint">
		Wiederherstellen: Server stoppen, dann <code>npm run restore -- &lt;datei&gt;</code>.
	</p>
</section>

<p class="version">
	Version <code>{data.version}</code> · Build <code>{data.buildDate}</code>
	{#if data.prerelease}<Badge tone="accent">Vorabversion</Badge>{/if}
</p>

<style>
	.sections {
		display: grid;
		gap: var(--space-2);
		max-width: 48ch;
		margin-top: var(--space-4);
		list-style: none;
		padding: 0;
	}
	.sections a {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		color: inherit;
		text-decoration: none;
	}
	.sections a:hover {
		background: var(--surface-hover);
	}
	.label {
		font-weight: 620;
	}
	.desc {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.backup {
		display: grid;
		gap: var(--space-2);
		max-width: 64ch;
		margin-top: var(--space-8);
	}
	.backup h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.backup dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		margin: 0;
	}
	.backup dt {
		color: var(--text-muted);
	}
	.backup dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--status-failed);
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.version {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-4);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
</style>
