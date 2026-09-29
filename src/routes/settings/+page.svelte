<h1>Einstellungen</h1>
<ul class="sections">
	<li>
		<a href="/settings/secrets">
			<span class="label">Secrets</span>
			<span class="desc">API-Keys und Tokens für Agent-Profile und MCP-Server, verschlüsselt gespeichert.</span>
		</a>
	</li>
</ul>

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
</style>
