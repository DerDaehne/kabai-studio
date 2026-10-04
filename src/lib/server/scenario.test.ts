import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFakeModel } from '../../../tests/browser/fake-model.ts';
import { listenerCount } from './events';
import { loadScenario, modelConfig, runScenario, type Scenario } from './scenario';

function scenarioFile(scenario: Scenario): string {
	const dir = mkdtempSync(join(tmpdir(), 'scenario-file-'));
	const file = join(dir, 'scenario.json');
	writeFileSync(file, JSON.stringify(scenario));
	return file;
}

describe('runScenario', () => {
	it('evaluates expectations, writes the report and cleans the instance up afterwards', async () => {
		const model = await startFakeModel();
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
				{ title: 'execution claim case', expect: {} }
			]
		};
		const dataRoot = mkdtempSync(join(tmpdir(), 'scenario-data-root-'));
		const outDir = mkdtempSync(join(tmpdir(), 'scenario-out-'));
		const listenersBefore = listenerCount();
		try {
			const results = await runScenario(scenarioFile(scenario), outDir, dataRoot);
			expect(results.map((result) => result.ok)).toEqual([true, false, false]);
			expect(results[1].reasons[0]).toContain('add_tasks');
			expect(results[2].reasons.some((reason) => reason.includes('Ausführung'))).toBe(true);
			expect(readdirSync(dataRoot)).toHaveLength(0); // the temporary instance directory is gone
			expect(listenerCount()).toBe(listenersBefore); // the runner unsubscribed from the event bus
			expect(readFileSync(join(outDir, 'report.txt'), 'utf8')).toContain('nicht ok');
			expect(readdirSync(outDir).some((name) => name.endsWith('.jsonl'))).toBe(true);
		} finally {
			await model.close();
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 20_000);
});

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
