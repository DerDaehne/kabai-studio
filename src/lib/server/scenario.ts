// `npm run scenario -- <scenario-file> <output-dir>` drives a throwaway studio instance in this one process
// (no build, no HTTP server — the builtin executor already reaches the studio MCP tools in-process, and the
// runner wakes on the in-memory event bus) against a real OpenAI-compatible model, then reports per ticket
// whether the agent did what its starting column expects.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { resumeAll } from './domain/halt';
import { answerQuestion, latestOpenQuestion, type Answer } from './domain/questions';
import { createProfile, createRun } from './domain/runs';
import { migrate, openDb } from './db';
import { builtinExecutor } from './executors/builtin';
import { startRunner, type RunnerHandle } from './runner';

const USER: Actor = { kind: 'user' };
const POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
// Stems catch inflected German forms ("kompilierte"); "run"/"running" stays out because studio calls an
// agent run exactly that.
const EXECUTION_CLAIM_WORDS =
	/\b(kompilier\w*|ausgeführt\w*|getestet\w*|compiled|executed|tested|ran)\b/gi;
const NEGATION_WORDS = /\b(nicht|kein\w*|nie\w*|not|never|cannot|can't)\b/i;
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
	/** The ticket's newest run when it settled: 'timed_out' if the harness had to cancel it. */
	runState: string;
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

/** The report and JSONL files carry model output, tool arguments and comments — never into the public repo. */
function refuseOutputInsideRepo(outDir: string): void {
	const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
	const rel = relative(repoRoot, resolve(outDir));
	const inside = rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
	if (inside)
		throw new Error(
			`Ausgabeordner „${outDir}“ liegt im Repository. Wähle einen Ordner außerhalb, z. B. $(mktemp -d).`
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
	migrate(db);
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

function stopInstance(instance: Instance | undefined, dataDir: string | undefined): void {
	if (instance) {
		instance.runner.stop();
		instance.db.close();
	}
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

function columnId(db: DatabaseSync, projectId: number, name: string): number {
	const row = db
		.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?')
		.get(projectId, name) as { id: number } | undefined;
	if (!row) throw new Error(`Spalte „${name}“ gibt es im Szenario-Projekt nicht.`);
	return row.id;
}

type RunRow = { id: number; state: string; error: string | null };
type StoredEvent = {
	seq: number;
	type: string;
	key: string | null;
	payload: Record<string, unknown>;
};

function runsOfTicket(db: DatabaseSync, ticketId: number): RunRow[] {
	return db
		.prepare('SELECT id, state, error FROM runs WHERE ticket_id = ? ORDER BY id')
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

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
	skipAnswerUndoWindow(db, newest.id);
	return 'answered';
}

/**
 * The harness scripts the answer itself, so it has no use for `ANSWER_UNDO_WINDOW_MS` (the window a human gets to
 * take an answer back) — waiting it out would cost 10s per scripted question. Clears the one follow-up run the
 * answer just queued and wakes the runner the same way `releaseHalt` already does, instead of polling for it.
 */
function skipAnswerUndoWindow(db: DatabaseSync, askingRunId: number): void {
	const changes = db
		.prepare(`UPDATE runs SET not_before = NULL WHERE resumed_from_run_id = ? AND state = 'queued'`)
		.run(askingRunId).changes;
	if (changes !== 1) return; // the answer only held back an already-waiting run, or queued none
	resumeAll(db, USER);
}

/** Waits for the ticket's run to settle; past `maxWaitMs` it cancels the still-active run and returns true. */
async function waitForOutcome(
	instance: Instance,
	ticketId: number,
	answer: Answer | undefined,
	maxWaitMs: number
): Promise<boolean> {
	const deadline = Date.now() + maxWaitMs;
	let answered = false;
	while (Date.now() < deadline) {
		const outcome = pollTicket(instance.db, ticketId, answer, answered);
		if (outcome === 'settled') return false;
		answered ||= outcome === 'answered';
		await sleep(POLL_INTERVAL_MS);
	}
	const active = runsOfTicket(instance.db, ticketId).at(-1);
	if (active && !TERMINAL_STATES.has(active.state)) instance.runner.cancel(active.id);
	return true;
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

const sentencesOf = (text: string): string[] =>
	text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim().length > 0);

/** The first claim-word match in `sentence` not preceded there by a negation, or undefined if none qualifies. */
function unnegatedClaimIn(sentence: string): string | undefined {
	for (const match of sentence.matchAll(EXECUTION_CLAIM_WORDS))
		if (!NEGATION_WORDS.test(sentence.slice(0, match.index))) return sentence.trim();
	return undefined;
}

/** A comment claiming a compile, run or test needs a matching tool call in the same run, or it counts as a hallucination. */
function executionClaim(comments: string[], tools: string[]): string | undefined {
	if (tools.some((tool) => EXECUTION_TOOLS.has(tool))) return undefined;
	for (const sentence of comments.flatMap(sentencesOf)) {
		const claim = unnegatedClaimIn(sentence);
		if (claim)
			return `Kommentar behauptet eine Ausführung ohne passenden Werkzeugaufruf: „${claim.slice(0, 80)}“`;
	}
	return undefined;
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

function expectationReasons(expect: ScenarioExpectations, actual: Actual): string[] {
	const reasons = [
		...endColumnReasons(expect, actual),
		...requiredToolReasons(expect, actual),
		...forbiddenToolReasons(expect, actual),
		...otherReasons(expect, actual)
	];
	const claim = executionClaim(actual.comments, actual.tools);
	if (claim) reasons.push(claim);
	return reasons;
}

/** Independent of what the scenario asked for: a run that timed out, failed or was cancelled is never "ok". */
function runStateReasons(runs: RunRow[], timedOut: boolean, maxWaitMs: number): string[] {
	if (timedOut)
		return [`Zeitgrenze von ${Math.round(maxWaitMs / 1000)} s überschritten, Run abgebrochen`];
	const last = runs.at(-1);
	if (last?.state === 'failed') return [`Run fehlgeschlagen: ${last.error ?? 'kein Fehlertext'}`];
	if (last?.state === 'cancelled') return ['Run abgebrochen'];
	return [];
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
	startedAt: number,
	timedOut: boolean,
	maxWaitMs: number
): TicketResult {
	const events = eventsByRun.flat();
	const actual: Actual = {
		endColumn: board.ticket(db, ticketId).column_name,
		tools: toolCallsOf(events),
		steps: eventsByRun.reduce((sum, runEvents) => sum + stepCountOf(runEvents), 0),
		comments: commentsOf(db, ticketId),
		requestHumanAsked: requestHumanAskedOf(db, ticketId)
	};
	const reasons = [
		...runStateReasons(runs, timedOut, maxWaitMs),
		...expectationReasons(spec.expect, actual)
	];
	const usage = usageOf(db, runs);
	return {
		title: spec.title,
		startColumn,
		endColumn: actual.endColumn,
		runState: timedOut ? 'timed_out' : (runs.at(-1)?.state ?? 'none'),
		steps: actual.steps,
		tools: actual.tools,
		tokensIn: usage.in,
		tokensOut: usage.out,
		durationMs: Date.now() - startedAt,
		ok: reasons.length === 0,
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
	const timedOut = await waitForOutcome(instance, ticketId, spec.requestHumanAnswer, maxWaitMs);
	const runs = runsOfTicket(instance.db, ticketId);
	const eventsByRun = runs.map((run) => eventsOfRun(instance.db, run.id));
	runs.forEach((run, i) => writeRunJsonl(run.id, eventsByRun[i], outDir));
	return buildResult(
		instance.db,
		spec,
		ticketId,
		runs,
		eventsByRun,
		startColumn,
		startedAt,
		timedOut,
		maxWaitMs
	);
}

function reportLine(result: TicketResult): string {
	const status = result.ok ? 'ok' : `nicht ok (${result.reasons.join('; ')})`;
	return (
		`${result.title}: ${result.startColumn} → ${result.endColumn} [${result.runState}], ` +
		`${result.steps} Schritte, Werkzeuge [${result.tools.join(', ')}], ` +
		`${result.tokensIn}/${result.tokensOut} Tokens, ${Math.round(result.durationMs / 1000)} s — ${status}`
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
	refuseOutputInsideRepo(outDir);
	const maxWaitMs = scenario.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	let instance: Instance | undefined;
	let dataDir: string | undefined;
	const onSignal = () => {
		stopInstance(instance, dataDir);
		process.exit(130);
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);
	try {
		mkdirSync(outDir, { recursive: true });
		dataDir = mkdtempSync(join(dataDirBase, 'studio-scenario-'));
		instance = startInstance(dataDir, baseUrl, model);
		const results: TicketResult[] = [];
		for (const spec of scenario.tickets)
			results.push(await runTicket(instance, spec, maxWaitMs, outDir));
		writeReport(results, outDir);
		return results;
	} finally {
		process.removeListener('SIGINT', onSignal);
		process.removeListener('SIGTERM', onSignal);
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
