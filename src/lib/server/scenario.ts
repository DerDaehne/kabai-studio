// `npm run scenario -- <scenario-file> <output-dir>` drives a throwaway studio instance in this one process
// (no build, no HTTP server — the builtin executor already reaches the studio MCP tools in-process, and the
// runner wakes on the in-memory event bus) against a real OpenAI-compatible model, then reports per ticket
// whether the agent did what its starting column expects.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { answerQuestion, latestOpenQuestion, type Answer } from './domain/questions';
import { createProfile, createRun } from './domain/runs';
import { migrate, openDb } from './db';
import { builtinExecutor } from './executors/builtin';
import { startRunner, type RunnerHandle } from './runner';

const USER: Actor = { kind: 'user' };
const POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const EXECUTION_CLAIM_WORDS = /\b(compiled|ran|executed|tested|ausgeführt|getestet|kompiliert)\b/i;
// ponytail: the MVP ships no execution tool at all, so this set stays empty and every claim fails; fill it in
// once a tool like that exists, so a call to it clears the claim again.
const EXECUTION_TOOLS = new Set<string>();

export type ScenarioExpectations = {
	endColumn?: string;
	requiredTools?: string[];
	forbiddenTools?: string[];
	commentHasCodeBlock?: boolean;
	requestHumanAsked?: boolean;
	maxSteps?: number;
};
export type ScenarioTicket = {
	title: string;
	description?: string;
	/** Starting column by name, e.g. "Refine"; defaults to the project's first column (Backlog). */
	column?: string;
	/** Answers an open request_human question once with this; omit to see the ticket stop there. */
	requestHumanAnswer?: Answer;
	expect: ScenarioExpectations;
};
export type Scenario = {
	baseUrl?: string;
	model?: string;
	maxWaitMs?: number;
	tickets: ScenarioTicket[];
};
export type TicketResult = {
	title: string;
	startColumn: string;
	endColumn: string;
	steps: number;
	tools: string[];
	tokensIn: number;
	tokensOut: number;
	durationMs: number;
	ok: boolean;
	reasons: string[];
};

export function loadScenario(path: string): Scenario {
	const scenario = JSON.parse(readFileSync(path, 'utf8')) as Scenario;
	if (!Array.isArray(scenario.tickets) || scenario.tickets.length === 0)
		throw new Error(`${path}: "tickets" muss eine nicht-leere Liste sein.`);
	return scenario;
}

/** Never defaults to a real address: the maintainer's local endpoint does not belong in this repository. */
export function modelConfig(scenario: Scenario): { baseUrl: string; model: string } {
	const baseUrl = scenario.baseUrl ?? process.env.STUDIO_SCENARIO_BASE_URL;
	const model = scenario.model ?? process.env.STUDIO_SCENARIO_MODEL;
	if (baseUrl && model) return { baseUrl, model };
	throw new Error(
		'Kein Modell konfiguriert: STUDIO_SCENARIO_BASE_URL und STUDIO_SCENARIO_MODEL setzen, oder ' +
			'"baseUrl"/"model" in der Szenario-Datei angeben. Beispiel:\n' +
			'STUDIO_SCENARIO_BASE_URL=http://127.0.0.1:<port>/v1 STUDIO_SCENARIO_MODEL=<model> ' +
			'npm run scenario -- scenarios/columns.json <ausgabeordner>'
	);
}

/** Reads `migrations/*.sql` straight from disk instead of relying on `migrate()`'s own `import.meta.glob` default. */
function loadMigrations(): Record<string, string> {
	const dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
	return Object.fromEntries(
		readdirSync(dir)
			.filter((name) => name.endsWith('.sql'))
			.map((name) => [name, readFileSync(join(dir, name), 'utf8')])
	);
}

export type Instance = {
	db: DatabaseSync;
	projectId: number;
	profileId: number;
	runner: RunnerHandle;
};

export function startInstance(dataDir: string, baseUrl: string, model: string): Instance {
	mkdirSync(dataDir, { recursive: true });
	const db = openDb(join(dataDir, 'studio.db'));
	migrate(db, loadMigrations());
	const { id: projectId } = board.createProject(db, USER, { key: 'SCN', name: 'Scenario' });
	const { id: profileId } = createProfile(db, USER, {
		name: 'scenario',
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: baseUrl,
		model
	});
	const runner = startRunner(db, { builtin: builtinExecutor(db) });
	return { db, projectId, profileId, runner };
}

export function stopInstance(instance: Instance, dataDir: string): void {
	instance.runner.stop();
	instance.db.close();
	rmSync(dataDir, { recursive: true, force: true });
}

function columnId(db: DatabaseSync, projectId: number, name: string): number {
	const row = db
		.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?')
		.get(projectId, name) as { id: number } | undefined;
	if (!row) throw new Error(`Spalte „${name}“ gibt es im Szenario-Projekt nicht.`);
	return row.id;
}

type RunRow = { id: number; state: string };
type StoredEvent = {
	seq: number;
	type: string;
	key: string | null;
	payload: Record<string, unknown>;
};

function runsOfTicket(db: DatabaseSync, ticketId: number): RunRow[] {
	return db
		.prepare('SELECT id, state FROM runs WHERE ticket_id = ? ORDER BY id')
		.all(ticketId) as RunRow[];
}

function eventsOfRun(db: DatabaseSync, runId: number): StoredEvent[] {
	const rows = db
		.prepare(
			'SELECT seq, type, idempotency_key AS key, payload FROM run_events WHERE run_id = ? ORDER BY seq'
		)
		.all(runId) as { seq: number; type: string; key: string | null; payload: string }[];
	return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One poll of a ticket's newest run: 'settled' once nothing more will happen (including a pause with no scripted
 * answer left), 'answered' right after a scripted request_human answer queued the follow-up run, else 'waiting'.
 */
function pollTicket(
	db: DatabaseSync,
	ticketId: number,
	answer: Answer | undefined,
	alreadyAnswered: boolean
): 'settled' | 'answered' | 'waiting' {
	const newest = runsOfTicket(db, ticketId).at(-1);
	if (!newest || TERMINAL_STATES.has(newest.state)) return 'settled';
	if (newest.state !== 'paused') return 'waiting';
	if (alreadyAnswered || !answer) return 'settled';
	const question = latestOpenQuestion(db, ticketId);
	if (!question) return 'settled';
	answerQuestion(db, USER, question.id, answer);
	return 'answered';
}

async function waitForOutcome(
	db: DatabaseSync,
	ticketId: number,
	answer: Answer | undefined,
	maxWaitMs: number
): Promise<void> {
	const deadline = Date.now() + maxWaitMs;
	let answered = false;
	while (Date.now() < deadline) {
		const outcome = pollTicket(db, ticketId, answer, answered);
		if (outcome === 'settled') return;
		answered ||= outcome === 'answered';
		await sleep(POLL_INTERVAL_MS);
	}
}

const toolCallsOf = (events: StoredEvent[]): string[] =>
	events.filter((e) => e.type === 'tool_call').map((e) => String(e.payload.tool));

function stepCountOf(events: StoredEvent[]): number {
	const steps = events
		.filter((e) => e.type === 'log' && e.payload.kind === 'step')
		.map((e) => Number(e.payload.step));
	return steps.length ? Math.max(...steps) : 0;
}

const commentsOf = (db: DatabaseSync, ticketId: number): string[] =>
	(
		db.prepare('SELECT body FROM comments WHERE ticket_id = ? ORDER BY id').all(ticketId) as {
			body: string;
		}[]
	).map((row) => row.body);

const requestHumanAskedOf = (db: DatabaseSync, ticketId: number): boolean =>
	db.prepare('SELECT 1 FROM questions WHERE ticket_id = ? LIMIT 1').get(ticketId) !== undefined;

const hasCodeBlock = (text: string): boolean => text.includes('```');

/** The check from #921's report of a hallucinated "compiled and ran" comment: a claim needs a matching tool call. */
function executionClaim(comments: string[], tools: string[]): string | undefined {
	const claim = comments.find((comment) => EXECUTION_CLAIM_WORDS.test(comment));
	if (!claim) return undefined;
	if (tools.some((tool) => EXECUTION_TOOLS.has(tool))) return undefined;
	return `Kommentar behauptet eine Ausführung ohne passenden Werkzeugaufruf: „${claim.slice(0, 80)}“`;
}

type Actual = {
	endColumn: string;
	tools: string[];
	steps: number;
	comments: string[];
	requestHumanAsked: boolean;
};

function endColumnReasons(expect: ScenarioExpectations, actual: Actual): string[] {
	if (!expect.endColumn || actual.endColumn === expect.endColumn) return [];
	return [`Endspalte „${actual.endColumn}“ statt „${expect.endColumn}“`];
}

function requiredToolReasons(expect: ScenarioExpectations, actual: Actual): string[] {
	return (expect.requiredTools ?? [])
		.filter((tool) => !actual.tools.includes(tool))
		.map((tool) => `Werkzeug „${tool}“ wurde nicht aufgerufen`);
}

function forbiddenToolReasons(expect: ScenarioExpectations, actual: Actual): string[] {
	return (expect.forbiddenTools ?? [])
		.filter((tool) => actual.tools.includes(tool))
		.map((tool) => `Werkzeug „${tool}“ war verboten`);
}

function otherReasons(expect: ScenarioExpectations, actual: Actual): string[] {
	const reasons: string[] = [];
	if (expect.commentHasCodeBlock && !actual.comments.some(hasCodeBlock))
		reasons.push('kein Kommentar mit Code-Block');
	if (expect.requestHumanAsked && !actual.requestHumanAsked)
		reasons.push('request_human wurde nicht gestellt');
	if (expect.maxSteps !== undefined && actual.steps > expect.maxSteps)
		reasons.push(`${actual.steps} Schritte statt höchstens ${expect.maxSteps}`);
	return reasons;
}

function evaluate(
	expect: ScenarioExpectations,
	actual: Actual
): { ok: boolean; reasons: string[] } {
	const reasons = [
		...endColumnReasons(expect, actual),
		...requiredToolReasons(expect, actual),
		...forbiddenToolReasons(expect, actual),
		...otherReasons(expect, actual)
	];
	const claim = executionClaim(actual.comments, actual.tools);
	if (claim) reasons.push(claim);
	return { ok: reasons.length === 0, reasons };
}

function writeRunJsonl(runId: number, events: StoredEvent[], outDir: string): void {
	const lines = events.map((event) => JSON.stringify(event));
	writeFileSync(join(outDir, `run-${runId}.jsonl`), lines.length ? lines.join('\n') + '\n' : '');
}

function usageOf(db: DatabaseSync, runs: RunRow[]): { in: number; out: number } {
	return runs.reduce(
		(sum, run) => {
			const row = db.prepare('SELECT tokens_in, tokens_out FROM runs WHERE id = ?').get(run.id) as {
				tokens_in: number;
				tokens_out: number;
			};
			return { in: sum.in + row.tokens_in, out: sum.out + row.tokens_out };
		},
		{ in: 0, out: 0 }
	);
}

function buildResult(
	db: DatabaseSync,
	spec: ScenarioTicket,
	ticketId: number,
	runs: RunRow[],
	eventsByRun: StoredEvent[][],
	startColumn: string,
	startedAt: number
): TicketResult {
	const events = eventsByRun.flat();
	const actual: Actual = {
		endColumn: board.ticket(db, ticketId).column_name,
		tools: toolCallsOf(events),
		steps: eventsByRun.reduce((sum, runEvents) => sum + stepCountOf(runEvents), 0),
		comments: commentsOf(db, ticketId),
		requestHumanAsked: requestHumanAskedOf(db, ticketId)
	};
	const { ok, reasons } = evaluate(spec.expect, actual);
	const usage = usageOf(db, runs);
	return {
		title: spec.title,
		startColumn,
		endColumn: actual.endColumn,
		steps: actual.steps,
		tools: actual.tools,
		tokensIn: usage.in,
		tokensOut: usage.out,
		durationMs: Date.now() - startedAt,
		ok,
		reasons
	};
}

async function runTicket(
	instance: Instance,
	spec: ScenarioTicket,
	maxWaitMs: number,
	outDir: string
): Promise<TicketResult> {
	const startedAt = Date.now();
	const startAt = spec.column ? columnId(instance.db, instance.projectId, spec.column) : undefined;
	const { id: ticketId } = board.createTicket(instance.db, USER, instance.projectId, {
		title: spec.title,
		description: spec.description ?? '',
		column_id: startAt
	});
	const startColumn = board.ticket(instance.db, ticketId).column_name;
	createRun(instance.db, USER, { ticketId, profileId: instance.profileId });
	await waitForOutcome(instance.db, ticketId, spec.requestHumanAnswer, maxWaitMs);
	const runs = runsOfTicket(instance.db, ticketId);
	const eventsByRun = runs.map((run) => eventsOfRun(instance.db, run.id));
	runs.forEach((run, i) => writeRunJsonl(run.id, eventsByRun[i], outDir));
	return buildResult(instance.db, spec, ticketId, runs, eventsByRun, startColumn, startedAt);
}

function reportLine(result: TicketResult): string {
	const status = result.ok ? 'ok' : `nicht ok (${result.reasons.join('; ')})`;
	return (
		`${result.title}: ${result.startColumn} → ${result.endColumn}, ${result.steps} Schritte, ` +
		`Werkzeuge [${result.tools.join(', ')}], ${result.tokensIn}/${result.tokensOut} Tokens, ` +
		`${Math.round(result.durationMs / 1000)} s — ${status}`
	);
}

function writeReport(results: TicketResult[], outDir: string): void {
	const lines = results.map(reportLine);
	writeFileSync(join(outDir, 'report.txt'), lines.join('\n') + '\n');
	for (const line of lines) console.log(line);
}

/** Runs every ticket of the scenario in its own throwaway instance, writes the report and one JSONL file per run. */
export async function runScenario(
	scenarioPath: string,
	outDir: string,
	dataDirBase = tmpdir()
): Promise<TicketResult[]> {
	const scenario = loadScenario(scenarioPath);
	const { baseUrl, model } = modelConfig(scenario);
	const maxWaitMs = scenario.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const dataDir = mkdtempSync(join(dataDirBase, 'studio-scenario-'));
	mkdirSync(outDir, { recursive: true });
	const instance = startInstance(dataDir, baseUrl, model);
	try {
		const results: TicketResult[] = [];
		for (const spec of scenario.tickets)
			results.push(await runTicket(instance, spec, maxWaitMs, outDir));
		writeReport(results, outDir);
		return results;
	} finally {
		stopInstance(instance, dataDir);
	}
}

/**
 * The CLI entry: reads `<scenario-file> <output-dir>` from argv. Called through `scripts/scenario.ts`, a thin
 * loader that resolves this module's extensionless, `$lib`-free imports through Vite — the same way vitest
 * already does for this file's own self-test, and the reason there is no plain `node` entry point here.
 */
export async function main(): Promise<void> {
	const [scenarioPath, outDir] = process.argv.slice(2);
	if (!scenarioPath || !outDir)
		throw new Error('Aufruf: npm run scenario -- <szenario-datei> <ausgabeordner>');
	const results = await runScenario(scenarioPath, outDir);
	if (results.some((result) => !result.ok)) process.exitCode = 1;
}
