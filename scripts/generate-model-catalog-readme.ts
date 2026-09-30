// Regenerates the "Local models" table in README.md from src/lib/agents/model-catalog.ts so the
// table and the catalog can never drift apart. Run via `npm run docs:models` after editing the
// catalog; model-catalog.readme.test.ts fails the build if someone forgets.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODEL_ROLES, type ModelEntry, MODELS } from '../src/lib/agents/model-catalog.ts';

export const MARKER_START = '<!-- BEGIN GENERATED: model-catalog -->';
export const MARKER_END = '<!-- END GENERATED: model-catalog -->';

function formatThinking(entry: ModelEntry): string {
	const state = entry.thinking.enabled === null ? 'configurable' : entry.thinking.enabled ? 'on' : 'off';
	return `${state} (${entry.thinking.method})`;
}

function formatContext(contextMinimum?: number): string {
	if (!contextMinimum) return '—';
	return contextMinimum % 1024 === 0 ? `${contextMinimum / 1024}k` : String(contextMinimum);
}

function formatRoles(entry: ModelEntry): string {
	const recommended = MODEL_ROLES.filter((role) => entry.roles[role] === 'recommended');
	if (recommended.length > 0) return recommended.join(', ');
	const acceptable = MODEL_ROLES.filter((role) => entry.roles[role] === 'acceptable');
	if (acceptable.length > 0) return `${acceptable.join(', ')} (acceptable)`;
	return '—';
}

function formatPitfalls(entry: ModelEntry): string {
	return entry.pitfalls.map((p) => `${p.problem} → ${p.fix}`).join('; ');
}

export function renderModelsSection(models: readonly ModelEntry[]): string {
	const header = '| Model | Recommended for | Thinking | Min. context | Known pitfalls |\n|---|---|---|---|---|';
	const rows = models.map(
		(m) => `| \`${m.id}\` | ${formatRoles(m)} | ${formatThinking(m)} | ${formatContext(m.contextMinimum)} | ${formatPitfalls(m)} |`
	);
	return [header, ...rows].join('\n');
}

export function buildReadme(readme: string, models: readonly ModelEntry[]): string {
	const start = readme.indexOf(MARKER_START);
	const end = readme.indexOf(MARKER_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`README.md is missing the ${MARKER_START} / ${MARKER_END} markers`);
	}
	const before = readme.slice(0, start + MARKER_START.length);
	const after = readme.slice(end);
	return `${before}\n${renderModelsSection(models)}\n${after}`;
}

function main() {
	const readmeUrl = new URL('../README.md', import.meta.url);
	const current = readFileSync(readmeUrl, 'utf8');
	const next = buildReadme(current, MODELS);
	if (next === current) {
		console.log('README.md already matches the model catalog.');
		return;
	}
	writeFileSync(readmeUrl, next);
	console.log('README.md updated with the current model catalog.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
