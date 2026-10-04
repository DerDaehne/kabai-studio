import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeModel, type FakeModel } from '../../../tests/browser/fake-model.ts';
import { listenerCount } from './events';
import {
	loadScenario,
	modelConfig,
	runScenario,
	type Scenario,
	type TicketResult
} from './scenario';

function scenarioFile(scenario: Scenario): string {
	const dir = mkdtempSync(join(tmpdir(), 'scenario-file-'));
	const file = join(dir, 'scenario.json');
	writeFileSync(file, JSON.stringify(scenario));
	return file;
}

describe('runScenario expectation checks', () => {
	let model: FakeModel;
	let dataRoot: string;
	let outDir: string;
	let results: TicketResult[];
	let listenersBefore: number;

	beforeAll(async () => {
		model = await startFakeModel();
		model.reply(
			{ call: { name: 'add_tasks', args: { titles: ['Write the function'] } } },
			{ call: { name: 'add_comment', args: { text: 'Done:\n```c\nint x;\n```' } } },
			{ text: 'Finished.' }
		);
		model.reply({ call: { name: 'add_tasks', args: { titles: ['x'] } } }, { text: 'done' });
		model.reply(
			{
				call: {
					name: 'add_comment',
					args: { text: 'Ich habe den Code kompiliert und erfolgreich ausgeführt.' }
				}
			},
			{ text: 'done' }
		);
		model.reply({ text: 'no tool needed' }); // required tool missing
		model.reply({ text: 'staying put' }); // end column violation
		model.reply(
			{ call: { name: 'add_comment', args: { text: 'Plain text, no code here.' } } },
			{ text: 'done' }
		); // code block missing
		model.reply({ call: { name: 'add_tasks', args: { titles: ['x'] } } }, { text: 'done' }); // max steps violation (2 steps)
		model.reply({ text: 'never asked' }); // request_human expected but not asked

		const scenario: Scenario = {
			baseUrl: model.baseUrl,
			model: 'fake',
			tickets: [
				{
					title: 'ok case',
					column: 'Refine',
					expect: { endColumn: 'Refine', requiredTools: ['add_tasks'], commentHasCodeBlock: true }
				},
				{ title: 'forbidden tool case', expect: { forbiddenTools: ['add_tasks'] } },
				{ title: 'execution claim case', expect: {} },
				{ title: 'required tool missing case', expect: { requiredTools: ['move_ticket'] } },
				{ title: 'end column violation case', expect: { endColumn: 'Ready' } },
				{ title: 'code block missing case', expect: { commentHasCodeBlock: true } },
				{ title: 'max steps violation case', expect: { maxSteps: 1 } },
				{ title: 'request human asked violation case', expect: { requestHumanAsked: true } }
			]
		};
		dataRoot = mkdtempSync(join(tmpdir(), 'scenario-data-root-'));
		outDir = mkdtempSync(join(tmpdir(), 'scenario-out-'));
		listenersBefore = listenerCount();
		results = await runScenario(scenarioFile(scenario), outDir, dataRoot);
	}, 20_000);

	afterAll(async () => {
		await model.close();
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	});

	it('passes a ticket that meets every expectation', () => {
		expect(results[0].ok).toBe(true);
		expect(results[0].reasons).toEqual([]);
	});

	it('flags a forbidden tool that was called', () => {
		expect(results[1].ok).toBe(false);
		expect(results[1].reasons[0]).toContain('add_tasks');
	});

	it('flags an execution claim without a matching tool call', () => {
		expect(results[2].ok).toBe(false);
		expect(results[2].reasons.some((reason) => reason.includes('Ausführung'))).toBe(true);
	});

	it('flags a required tool that was never called', () => {
		expect(results[3].ok).toBe(false);
		expect(results[3].reasons.some((reason) => reason.includes('move_ticket'))).toBe(true);
	});

	it('flags the wrong end column', () => {
		expect(results[4].ok).toBe(false);
		expect(results[4].reasons.some((reason) => reason.includes('Endspalte'))).toBe(true);
	});

	it('flags a missing code-block comment', () => {
		expect(results[5].ok).toBe(false);
		expect(results[5].reasons.some((reason) => reason.includes('Code-Block'))).toBe(true);
	});

	it('flags exceeding the step budget', () => {
		expect(results[6].ok).toBe(false);
		expect(results[6].reasons.some((reason) => reason.includes('Schritte'))).toBe(true);
	});

	it('flags a missing request_human call', () => {
		expect(results[7].ok).toBe(false);
		expect(results[7].reasons.some((reason) => reason.includes('request_human'))).toBe(true);
	});

	it('cleans the temporary instance up afterwards', () => {
		expect(readdirSync(dataRoot)).toHaveLength(0); // the temporary instance directory is gone
		expect(listenerCount()).toBe(listenersBefore); // the runner unsubscribed from the event bus
	});

	it('writes a readable report and one JSONL file per run', () => {
		expect(readFileSync(join(outDir, 'report.txt'), 'utf8')).toContain('nicht ok');
		expect(readdirSync(outDir).some((name) => name.endsWith('.jsonl'))).toBe(true);
	});
});

describe('runScenario run-state checks', () => {
	it('a ticket whose run outlasts maxWaitMs is not reported as ok, and the run is cancelled', async () => {
		const model = await startFakeModel();
		model.reply('hang');
		const dataRoot = mkdtempSync(join(tmpdir(), 'probe-data-'));
		const outDir = mkdtempSync(join(tmpdir(), 'probe-out-'));
		try {
			const file = scenarioFile({
				baseUrl: model.baseUrl,
				model: 'fake',
				maxWaitMs: 1500,
				tickets: [{ title: 'hangs', expect: {} }]
			});
			const [result] = await runScenario(file, outDir, dataRoot);
			expect(result.ok).toBe(false);
			expect(result.runState).toBe('timed_out');
		} finally {
			await model.close();
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);

	it('a timed-out run is cancelled, so the next ticket of the scenario still gets its run', async () => {
		const model = await startFakeModel();
		model.reply('hang', { text: 'done' });
		const dir = mkdtempSync(join(tmpdir(), 'probe-'));
		const file = join(dir, 'scenario.json');
		writeFileSync(
			file,
			JSON.stringify({
				baseUrl: model.baseUrl,
				model: 'fake',
				maxWaitMs: 1500,
				tickets: [
					{ title: 'hangs', expect: {} },
					{ title: 'next', expect: {} }
				]
			})
		);
		try {
			const [hung, next] = await runScenario(file, join(dir, 'out'), dir);
			expect(hung.reasons[0]).toContain('Zeitgrenze');
			expect(next.runState).toBe('succeeded');
		} finally {
			await model.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it('a ticket whose run fails is not reported as ok', async () => {
		const model = await startFakeModel(); // no scripted reply: the first request gets a 500 from the fake server
		const dataRoot = mkdtempSync(join(tmpdir(), 'probe-data-'));
		const outDir = mkdtempSync(join(tmpdir(), 'probe-out-'));
		try {
			const file = scenarioFile({
				baseUrl: model.baseUrl,
				model: 'fake',
				tickets: [{ title: 'fails', expect: {} }]
			});
			const [result] = await runScenario(file, outDir, dataRoot);
			expect(result.ok).toBe(false);
			expect(result.runState).toBe('failed');
		} finally {
			await model.close();
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);
});

describe('executionClaim negation and inflection', () => {
	it('an agent that says it did NOT compile or run the code is not flagged as an execution claim', async () => {
		const model = await startFakeModel();
		model.reply(
			{
				call: {
					name: 'add_comment',
					args: {
						text: 'Ungeprüft: nicht kompiliert und nicht ausgeführt, es gibt kein Ausführungswerkzeug.'
					}
				}
			},
			{ text: 'done' }
		);
		const dataRoot = mkdtempSync(join(tmpdir(), 'probe-data-'));
		const outDir = mkdtempSync(join(tmpdir(), 'probe-out-'));
		try {
			const file = scenarioFile({
				baseUrl: model.baseUrl,
				model: 'fake',
				tickets: [{ title: 'honest', expect: {} }]
			});
			const [result] = await runScenario(file, outDir, dataRoot);
			expect(result.reasons).toEqual([]);
		} finally {
			await model.close();
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);

	it('flags an inflected claim ("kompilierte") the same as the base word', async () => {
		const model = await startFakeModel();
		model.reply(
			{ call: { name: 'add_comment', args: { text: 'Der kompilierte Code läuft einwandfrei.' } } },
			{ text: 'done' }
		);
		const dataRoot = mkdtempSync(join(tmpdir(), 'probe-data-'));
		const outDir = mkdtempSync(join(tmpdir(), 'probe-out-'));
		try {
			const file = scenarioFile({
				baseUrl: model.baseUrl,
				model: 'fake',
				tickets: [{ title: 'inflected claim', expect: {} }]
			});
			const [result] = await runScenario(file, outDir, dataRoot);
			expect(result.reasons.some((reason) => reason.includes('Ausführung'))).toBe(true);
		} finally {
			await model.close();
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);
});

describe('runScenario output and cleanup safety', () => {
	it('refuses an output directory inside the repository', async () => {
		const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const inside = join(repoRoot, 'probe-scenario-out');
		const file = scenarioFile({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'x',
			tickets: [{ title: 't', column: 'Nope', expect: {} }]
		});
		try {
			await runScenario(file, inside).catch(() => undefined);
			expect(existsSync(inside)).toBe(false);
		} finally {
			rmSync(inside, { recursive: true, force: true });
		}
	});

	it('leaves no temporary data directory when the output directory cannot be created', async () => {
		const dataRoot = mkdtempSync(join(tmpdir(), 'probe-data-'));
		const notADir = join(mkdtempSync(join(tmpdir(), 'probe-file-')), 'file');
		writeFileSync(notADir, '');
		const file = scenarioFile({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'x',
			tickets: [{ title: 't', expect: {} }]
		});
		try {
			await expect(runScenario(file, join(notADir, 'out'), dataRoot)).rejects.toThrow();
			expect(readdirSync(dataRoot)).toHaveLength(0);
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});

	it('removes the temporary data directory on SIGINT', async () => {
		const model = await startFakeModel();
		model.reply('hang');
		const isolatedTmp = mkdtempSync(join(tmpdir(), 'scenario-sigint-tmp-'));
		const outDir = mkdtempSync(join(tmpdir(), 'scenario-sigint-out-'));
		const file = scenarioFile({
			baseUrl: model.baseUrl,
			model: 'fake',
			maxWaitMs: 60_000,
			tickets: [{ title: 'hangs', expect: {} }]
		});
		const scriptsEntry = fileURLToPath(new URL('../../../scripts/scenario.ts', import.meta.url));
		const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const child = spawn('node', [scriptsEntry, file, outDir], {
			cwd: repoRoot,
			env: { ...process.env, TMPDIR: isolatedTmp }
		});
		try {
			await waitForInstanceDir(isolatedTmp);
			child.kill('SIGINT');
			const code = await new Promise<number | null>((resolve) =>
				child.once('exit', (exitCode) => resolve(exitCode))
			);
			expect(code).toBe(130);
			expect(readdirSync(isolatedTmp)).toHaveLength(0);
		} finally {
			child.kill('SIGKILL');
			await model.close();
			rmSync(isolatedTmp, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);
});

async function waitForInstanceDir(dir: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (readdirSync(dir).some((name) => name.startsWith('studio-scenario-'))) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`No studio-scenario-* directory appeared in ${dir} in time.`);
}

describe('modelConfig', () => {
	it('throws a clear error naming the way out when no model is configured', () => {
		expect(() => modelConfig({ tickets: [] })).toThrow('STUDIO_SCENARIO_BASE_URL');
	});
});

describe('loadScenario', () => {
	it('rejects a scenario without tickets', () => {
		const file = scenarioFile({ tickets: [] });
		expect(() => loadScenario(file)).toThrow('tickets');
	});
});
