import {
	APICallError,
	streamText,
	type LanguageModel,
	type ModelMessage,
	type StepResult,
	type StopCondition,
	type TextStreamPart,
	type ToolSet
} from 'ai';
import type { DatabaseSync } from 'node:sqlite';
import { INACTIVITY_LIMIT_MS, reasoningBudget } from '../../agents/model-catalog';
import {
	detectStagnation,
	RECOVERY,
	recoveryHint,
	type CallRecord,
	type Stall,
	type StepRecord
} from '../agents/loop-guard';
import {
	assemblePrompt,
	promptBudget,
	resumeHistoryOf,
	type AssembledPrompt
} from '../agents/prompt';
import { callTarget, deriveTrace, summarizeResult, type ToolCall } from '../agents/trace';
import * as board from '../domain/board';
import { DomainError } from '../domain/core';
import { collectAnswer } from '../domain/questions';
import { freshRunsInChain, type Intervention } from '../domain/runs';
import { mcpEndpoint, tasksOf } from '../mcp';
import {
	classifyProviderFailure,
	providerErrorHint,
	type ProviderErrorCode
} from '../provider-error';
import type {
	Executor,
	ExecutorIo,
	ExecutorResult,
	ParkReason,
	Phase,
	RunContext
} from '../runner';
import { mask } from '../secrets';
import { modelFor, requestSettings } from './provider';
import { studioTools } from './studio-mcp-client';

export type BuiltinOptions = {
	/** The HTTP client for the model server. */
	fetch?: typeof globalThis.fetch;
	inactivityMs?: number;
};
type Part = TextStreamPart<ToolSet>;
type OpenStep = {
	number: number;
	startedAt: number;
	reasoning: string;
	text: string;
	textsRecorded: boolean;
	meters: Partial<Record<Phase['name'], TokenMeter>>;
};
/** Tokens of one phase within a step, counted from its first delta. */
type TokenMeter = { tokens: number; since: number };

// ponytail: fixed limits; make them configurable once practice asks for it.
export const DEFAULT_MAX_STEPS = 24;
const REASONING_LIMIT = 20_000;
const RESULT_LIMIT = 8_000;
const PHASE_INTERVAL_MS = 1000;
// ponytail: the studio tools that only read; a read tool missing here counts as progress and only makes the guard more lenient
const READING_TOOLS = new Set(['get_ticket', 'list_workable', 'notes_search', 'notes_get']);

/** Works a run in a tool loop on an OpenAI-compatible model server, with the studio MCP tools of the run. */
export function builtinExecutor(
	db: DatabaseSync,
	{ fetch = globalThis.fetch, inactivityMs = INACTIVITY_LIMIT_MS }: BuiltinOptions = {}
): Executor {
	const endpoint = mcpEndpoint(db);
	return {
		async execute(run, io) {
			const prompt = promptOf(db, run);
			const collect = () => collectAnswer(db, { kind: 'agent', runId: run.id }, run.ticketId);
			const model = modelFor(
				db,
				run.profile,
				prompt.showsHumanAnswer ? afterFirstRequest(fetch, collect) : fetch
			);
			const studio = await studioTools(endpoint, run.token, io.signal);
			try {
				io.emit({
					type: 'log',
					payload: {
						kind: 'prompt',
						estimate: prompt.estimate,
						toolTokens: studio.toolTokens,
						blocks: prompt.blocks
					}
				});
				const log = await runSteps({ model, prompt, tools: studio.tools, run, io, inactivityMs });
				return endOfRun(db, run, io, log);
			} finally {
				await studio.close();
			}
		}
	};
}

/**
 * A run that continues another gets that run's conversation as turns before its prompt when both fit the prompt budget;
 * otherwise the prompt carries that run's handoff.
 */
function promptOf(db: DatabaseSync, run: RunContext): RunPrompt {
	const withHistory = assemblePrompt(db, run, { history: true });
	const history = resumeHistoryOf(db, run.id, promptBudget(run.profile) - withHistory.estimate);
	if (!history) return { ...assemblePrompt(db, run), history: [] };
	return { ...withHistory, history };
}

type RunPrompt = AssembledPrompt & { history: ModelMessage[] };
type Loop = {
	model: LanguageModel;
	prompt: RunPrompt;
	tools: ToolSet;
	run: RunContext;
	io: ExecutorIo;
	inactivityMs: number;
};

/**
 * Works the tool loop in attempts: a stuck run gets a hint as the next user message and goes on with its conversation.
 * Once the hints are used up or no step is left, the stall stays on the log and the run hands off to a fresh run.
 */
async function runSteps(loop: Loop): Promise<StepLog> {
	const { prompt, run, io } = loop;
	const log = new StepLog(io, loop.inactivityMs, run.profile.api_key_ref !== null);
	const limits = { reasoningBudget: reasoningBudget(run.profile) };
	let hintedAt = 0;
	const stall = () => detectStagnation(log.records.slice(hintedAt), limits);
	let messages: ModelMessage[] = [...prompt.history, { role: 'user', content: prompt.user }];
	for (let attempt = 1; ; attempt++) {
		const responseMessages = await streamSteps(loop, log, messages, () => stall() !== undefined);
		const stuck = endedStuck(log, io) ? stall() : undefined;
		if (!stuck) return log;
		if (attempt > RECOVERY.hintsPerRun || log.records.length >= maxSteps(run)) {
			log.stall = stuck;
			return log;
		}
		io.emit({
			type: 'intervention',
			payload: interventionOf(stuck, attempt, RECOVERY.hintsPerRun)
		});
		hintedAt = log.records.length;
		const hint: ModelMessage = { role: 'user', content: recoveryHint(stuck.cause) };
		messages = [...messages, ...(await responseMessages()), hint];
	}
}

/** One attempt: the AI SDK's tool loop until a step ends without a tool call or a stop condition holds. */
async function streamSteps(
	{ model, prompt, tools, run, io, inactivityMs }: Loop,
	log: StepLog,
	messages: ModelMessage[],
	stuck: () => boolean
): Promise<() => PromiseLike<ModelMessage[]>> {
	const result = streamText({
		model,
		instructions: prompt.system,
		messages,
		tools,
		...requestSettings(run.profile),
		abortSignal: io.signal,
		// ponytail: chunkMs starts with a step's first output, so loading the model stays the cold start watch's job; a later
		// step that never starts to answer is not caught (add firstChunkMs from the second step on), and the timer keeps running
		// while a tool executes, so a tool slower than the limit ends as provider_inactive (pause it between tool call and result)
		timeout: { chunkMs: inactivityMs },
		stopWhen: [() => log.records.length >= maxSteps(run), askedHuman, () => io.park.aborted, stuck],
		onChunk: ({ chunk }) => log.countChunk(chunk),
		onStepFinish: (step) => log.recordStep(step),
		onError: () => {} // errors arrive as stream parts and end the run there
	});
	for await (const part of result.fullStream) log.record(part);
	return () => result.responseMessages; // read only when needed: after a cancel it rejects
}

/** Only a run ended by the step limit or the guard, or by a step at the output limit, can be stuck; one that ended its last step on its own is done. */
function endedStuck(log: StepLog, io: ExecutorIo): boolean {
	if (io.signal.aborted || io.park.aborted || log.succeeded('request_human')) return false;
	return log.endedWithToolCalls() || log.records.at(-1)?.finishReason === 'length';
}

const interventionOf = (stall: Stall, attempt: number, max: number, reason = stall.reason) =>
	({
		kind: stall.kind,
		attempt,
		max,
		reason,
		hint: recoveryHint(stall.cause),
		stepTokens: stall.stepTokens
	}) satisfies Intervention;

/** Counts on the chain's fresh runs; beyond their maximum the runner asks the human instead of starting one. */
const freshRunIntervention = (db: DatabaseSync, run: RunContext, stall: Stall) =>
	interventionOf(
		stall,
		freshRunsInChain(db, run.id) + 1,
		RECOVERY.freshRunsPerChain,
		`${stall.reason} The run ends with a handoff.`
	);

const maxSteps = (run: RunContext) => run.profile.max_steps ?? DEFAULT_MAX_STEPS;
const isErrorResult = (output: unknown) =>
	(output as { isError?: unknown } | undefined)?.isError === true;
const askedHuman: StopCondition<ToolSet> = ({ steps }) =>
	steps
		.at(-1)
		?.toolResults.some((r) => r.toolName === 'request_human' && !isErrorResult(r.output)) ?? false;

/** Calls `sent` once the first request to the model server has gone out. */
function afterFirstRequest(
	fetch: typeof globalThis.fetch,
	sent: () => void
): typeof globalThis.fetch {
	let first = true;
	return (input, init) => {
		const response = fetch(input, init);
		if (first) sent();
		first = false;
		return response;
	};
}

function endOfRun(db: DatabaseSync, run: RunContext, io: ExecutorIo, log: StepLog): ExecutorResult {
	if (io.signal.aborted) return; // cancelled: the run has already ended and takes no more events
	if (log.stall)
		io.emit({ type: 'intervention', payload: freshRunIntervention(db, run, log.stall) });
	const handoff = log.lastMessage
		? { text: log.lastMessage }
		: { text: generatedHandoff(db, run, log), generated: true };
	const handoffSeq = io.emit({ type: 'message', key: 'handoff', payload: handoff }).seq;
	if (log.succeeded('request_human')) return { state: 'paused' };
	// a park that lands in the final step changes nothing: the work is done and a follow-up run would redo it
	if (io.park.aborted && log.endedWithToolCalls())
		return { state: 'paused', resume: { ...(io.park.reason as ParkReason), handoffSeq } };
	if (log.stall) return { state: 'paused', resume: { reason: 'recovery', handoffSeq } };
	if (log.endedWithToolCalls() && !log.succeeded('move_ticket'))
		throw new DomainError(
			'step_limit',
			`Der Run hat nach ${maxSteps(run)} Schritten aufgehört, ohne das Ticket zu verschieben.`,
			'Erhöhe max_steps im Agent-Profil oder schneide das Ticket kleiner, dann starte einen neuen Run.'
		);
	return { state: 'succeeded' };
}

/** A handoff from the run's events, so that a model ending without a closing text never leaves an empty trace. */
function generatedHandoff(db: DatabaseSync, run: RunContext, log: StepLog): string {
	const column = board.ticket(db, run.ticketId).column_name;
	const openTasks = tasksOf(db, run.ticketId).filter((task) => !task.done);
	return [
		"Summary: the model ended without a closing text; this handoff is generated from the run's events.",
		`Tools: ${toolUse(log.records) || 'none'}`,
		`Ticket: ${log.succeeded('move_ticket') ? `moved to ${column}` : `not moved, still in ${column}`}`,
		`Open tasks:${openTasks.length ? '' : ' none'}`,
		...openTasks.map((task) => `- ${task.id}: ${task.title}`)
	].join('\n');
}

/** Each tool with how often the run called it and how often that failed, in the order of first use. */
function toolUse(records: StepRecord[]): string {
	const uses = new Map<string, { calls: number; failed: number }>();
	for (const call of records.flatMap((record) => record.calls)) {
		const use = uses.get(call.tool) ?? { calls: 0, failed: 0 };
		uses.set(call.tool, { calls: use.calls + 1, failed: use.failed + Number(call.isError) });
	}
	return [...uses]
		.map(([tool, { calls, failed }]) => `${tool} ${calls}×${failed ? ` (${failed} failed)` : ''}`)
		.join(', ');
}

/** Turns the stream of the tool loop into run events (one set per step) and live phases, and keeps a record of every step. */
class StepLog {
	readonly records: StepRecord[] = [];
	lastMessage = '';
	/** Set when the run stays stuck with no hint or step left: it hands off to a fresh run. */
	stall?: Stall;
	readonly #io: ExecutorIo;
	readonly #inactivityMs: number;
	readonly #withKey: boolean;
	#step: OpenStep = openStep(1);
	#stepsStarted = 0;
	#reasoningDeltas = 0;
	#lastPhaseAt = -Infinity;

	constructor(io: ExecutorIo, inactivityMs: number, withKey: boolean) {
		this.#io = io;
		this.#inactivityMs = inactivityMs;
		this.#withKey = withKey;
	}

	succeeded(tool: string) {
		return this.records.some((record) =>
			record.calls.some((call) => call.tool === tool && !call.isError)
		);
	}

	endedWithToolCalls() {
		return (this.records.at(-1)?.calls.length ?? 0) > 0;
	}

	/** Called by the SDK in stream order before `recordStep`; `record` may see the same part later. */
	countChunk(part: Part) {
		if (part.type === 'reasoning-delta') this.#reasoningDeltas += 1;
	}

	/** Called by the SDK before it decides on the next step, so the records are complete whenever a stop condition reads them. */
	recordStep(step: StepResult<ToolSet>) {
		this.records.push({
			step: this.records.length + 1,
			finishReason: step.finishReason,
			inputTokens: step.usage.inputTokens,
			// ponytail: llama.cpp reports no reasoning tokens; one delta counts as one token there, as for the phase ticker
			reasoningTokens:
				step.usage.outputTokenDetails.reasoningTokens || this.#reasoningDeltas || undefined,
			calls: step.content.flatMap(callRecordOf)
		});
		this.#reasoningDeltas = 0;
	}

	record(part: Part) {
		switch (part.type) {
			case 'start-step':
				this.#step = openStep(++this.#stepsStarted);
				return;
			case 'reasoning-delta':
				this.#step.reasoning += part.text;
				return this.#showPhase('thinking', this.#step.reasoning);
			case 'text-delta':
				this.#step.text += part.text;
				return this.#showPhase('writing', this.#step.text);
			case 'tool-input-delta':
				return this.#showPhase('writing', '');
			case 'tool-call':
				return this.#recordToolCall(part);
			case 'tool-result':
				return this.#recordToolResult(
					part.toolCallId,
					{ tool: part.toolName, args: part.input },
					textOf(part.output),
					isErrorResult(part.output)
				);
			case 'tool-error':
				return this.#recordToolResult(
					part.toolCallId,
					{ tool: part.toolName, args: part.input },
					errorText(part.error),
					true
				);
			case 'finish-step':
				return this.#finishStep(part);
			case 'abort':
				if (this.#io.signal.aborted) return; // cancelled; otherwise only the inactivity timeout aborts the stream
				throw inactiveProvider(this.#inactivityMs);
			case 'error':
				throw providerError(part.error, this.#withKey);
		}
	}

	/** Throttled to one update a second; the first one comes at once, because it ends the runner's cold start watch. */
	#showPhase(name: Phase['name'], text: string) {
		const now = Date.now();
		// ponytail: one delta counts as one token, as llama.cpp, Ollama and LM Studio stream them; a server that
		// sends several tokens per delta shows too few (then count with the step's usage or a tokenizer)
		const meter = (this.#step.meters[name] ??= { tokens: 0, since: now });
		meter.tokens += 1;
		if (now - this.#lastPhaseAt < PHASE_INTERVAL_MS) return;
		this.#lastPhaseAt = now;
		this.#io.phase({
			name,
			elapsedMs: now - this.#step.startedAt,
			tokens: meter.tokens,
			tokensPerSecond: tokensPerSecond(meter, now),
			lastLine: lastCompleteLine(text)
		});
	}

	/** Reasoning and text of a step come before its first tool call; they are recorded once, with the step's first call or its end. */
	#recordTexts() {
		const step = this.#step;
		if (step.textsRecorded) return;
		step.textsRecorded = true;
		if (step.reasoning) {
			// masked before cutting, so that a secret cut in half is still recognised; the end of the reasoning leads to the step's action
			const text = mask(step.reasoning).slice(-REASONING_LIMIT);
			this.#io.emit({
				type: 'reasoning',
				key: `step:${step.number}:reasoning`,
				payload: { step: step.number, text, charsTotal: step.reasoning.length }
			});
		}
		const text = step.text.trim();
		if (!text) return;
		this.lastMessage = text;
		this.#io.emit({
			type: 'message',
			key: `step:${step.number}:message`,
			payload: { step: step.number, text }
		});
	}

	#recordToolCall(part: Extract<Part, { type: 'tool-call' }>) {
		this.#recordTexts();
		const { number, text, reasoning } = this.#step;
		const call = { tool: part.toolName, args: part.input };
		this.#io.emit({
			type: 'tool_call',
			key: part.toolCallId,
			payload: { step: number, ...call, ...deriveTrace(text, reasoning, call) }
		});
	}

	#recordToolResult(callId: string, call: ToolCall, result: string, isError: boolean) {
		const payload = {
			step: this.#step.number,
			tool: call.tool,
			result: mask(result).slice(0, RESULT_LIMIT),
			isError,
			...summarizeResult(call, result, isError)
		};
		this.#io.emit({ type: 'tool_result', key: `${callId}:result`, payload });
	}

	#finishStep({ finishReason, usage }: Extract<Part, { type: 'finish-step' }>) {
		this.#recordTexts();
		const step = this.#step;
		const reasoningTokens = usage.outputTokenDetails.reasoningTokens || undefined;
		const cachedInputTokens = usage.inputTokenDetails.cacheReadTokens || undefined;
		const tokensIn = usage.inputTokens ?? 0;
		const tokensOut = usage.outputTokens ?? 0;
		this.#io.emit({
			type: 'log',
			key: `step:${step.number}`,
			payload: {
				kind: 'step',
				step: step.number,
				finishReason,
				ms: Date.now() - step.startedAt,
				reasoningTokens,
				cachedInputTokens,
				// also in `usage` below (the run's total); kept here too, since the time-series read model has no other source
				tokensIn,
				tokensOut
			},
			// ponytail: cost 0 while only local models are supported; priced providers bring their prices into the catalog
			usage: { tokensIn, tokensOut, cost: 0 }
		});
	}
}

/** A tool call that got its result; progress is a successful call that changes something. */
function callRecordOf(part: StepResult<ToolSet>['content'][number]): CallRecord[] {
	if (part.type !== 'tool-result' && part.type !== 'tool-error') return [];
	const isError = part.type === 'tool-error' || isErrorResult(part.output);
	const call = { tool: part.toolName, args: part.input };
	const progress = !isError && !READING_TOOLS.has(call.tool);
	return [{ tool: call.tool, target: callTarget(call), isError, progress }];
}

const openStep = (number: number): OpenStep => ({
	number,
	startedAt: Date.now(),
	reasoning: '',
	text: '',
	textsRecorded: false,
	meters: {}
});

const tokensPerSecond = ({ tokens, since }: TokenMeter, now: number) =>
	now > since ? Math.round((tokens * 1000) / (now - since)) : undefined;

function lastCompleteLine(text: string) {
	const completeLines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
	return completeLines
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

/** The text an MCP tool answered with; other results as JSON. */
function textOf(output: unknown): string {
	const content = (output as { content?: { type: string; text?: string }[] } | undefined)?.content;
	if (!Array.isArray(content)) return JSON.stringify(output) ?? '';
	return content
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function providerError(error: unknown, withKey: boolean) {
	if (APICallError.isInstance(error)) {
		const code = classifyProviderFailure(error.statusCode);
		if (code)
			return new DomainError(
				code,
				mask(classifiedMessage(code, error)),
				providerErrorHint(code, { withKey })
			);
	}
	return new DomainError(
		'provider_error',
		mask(`Der Modell-Server hat mit einem Fehler geantwortet: ${errorText(error)}`),
		'Prüfe im Agent-Profil base_url, model und api_key_ref und im Log des Modell-Servers die Ursache, dann starte einen neuen Run.'
	);
}

function classifiedMessage(code: ProviderErrorCode, error: APICallError): string {
	if (code === 'provider_unreachable')
		return `Endpunkt ${new URL(error.url).origin} nicht erreichbar: ${errorText(error)}.`;
	if (code === 'model_unknown')
		return `Der Modell-Server kennt das Modell nicht: ${errorText(error)}`;
	return `Der Modell-Server verlangt oder verweigert den API-Key (HTTP ${error.statusCode}).`;
}

function inactiveProvider(inactivityMs: number) {
	return new DomainError(
		'provider_inactive',
		`Das Modell hat ${Math.round(inactivityMs / 1000)} s lang nichts mehr gesendet, nachdem es zu antworten begonnen hatte.`,
		'Prüfe im Log des Modell-Servers, ob er hängt oder abgestürzt ist, dann starte einen neuen Run.'
	);
}
