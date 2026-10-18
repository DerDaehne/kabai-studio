import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	aliveOf,
	endTestProcesses,
	removeAgentScripts,
	startAgentTree,
	startOutsider
} from './agent-tree.fixture';
import { KILL_GRACE_MS, killTree, processTable } from './tree-kill';

afterEach(endTestProcesses);
afterAll(removeAgentScripts);

const sorted = (pids: number[]) => [...pids].sort((a, b) => a - b);

describe('killTree with real processes', () => {
	it('ends an agent with its child, grandchild and a child in a session of its own within 5 s, SIGKILL only after the grace and only to survivors, once even when asked twice', async () => {
		const tree = await startAgentTree();
		const outsider = await startOutsider();
		const signals: { pid: number; signal: string; at: number }[] = [];
		const begin = Date.now();
		const kill = (pid: number, signal: NodeJS.Signals) => {
			signals.push({ pid, signal, at: Date.now() - begin });
			process.kill(pid, signal);
		};

		const first = killTree(tree.agent, { kill });
		const second = killTree(tree.agent, { kill });
		const [result, again] = await Promise.all([first, second]);
		const elapsed = Date.now() - begin;

		expect(again).toBe(result);
		expect(elapsed).toBeLessThanOrEqual(5000);
		expect(result).toMatchObject({ left: [], degraded: false });
		expect(sorted(result.tree)).toEqual(sorted(Object.values(tree)));
		// the agent itself ends on SIGTERM; its descendants stay behind as orphans until SIGKILL
		expect(sorted(result.sigkilled)).toEqual(sorted([tree.child, tree.grandchild, tree.detached]));
		expect(signals.filter((s) => s.signal === 'SIGTERM').map((s) => s.pid)).toEqual([tree.agent]);
		const sigkills = signals.filter((s) => s.signal === 'SIGKILL');
		expect(sorted(sigkills.map((s) => s.pid))).toEqual(sorted(result.sigkilled));
		for (const s of sigkills) expect(s.at).toBeGreaterThanOrEqual(KILL_GRACE_MS);

		expect(await aliveOf(tree)).toEqual([]);
		expect((await processTable())!.has(outsider)).toBe(true);
	});
});

/** One ps output per call, the last one repeated: the table before SIGTERM, after the grace, and after SIGKILL. */
function psSequence(...tables: [pid: number, ppid: number, started: string][][]) {
	let call = 0;
	return async () => {
		const rows = tables[Math.min(call++, tables.length - 1)];
		return rows.map(([pid, ppid, started]) => `  ${pid}  ${ppid} S    ${started}`).join('\n');
	};
}

function recorder() {
	const signals: [number, NodeJS.Signals][] = [];
	return {
		signals,
		kill: (pid: number, signal: NodeJS.Signals) => void signals.push([pid, signal])
	};
}

describe('killTree against a given process table', () => {
	const me = process.pid;
	const BOOT = 'Sun Oct 18 09:06:42 2026';

	it('sends SIGKILL to no captured PID whose start time changed and to no process outside the tree, but to what the survivors started meanwhile', async () => {
		const { signals, kill } = recorder();
		const ps = psSequence(
			[
				[1, 0, BOOT],
				[me, 1, BOOT],
				[500, me, 'Sun Oct 18 17:00:00 2026'],
				[501, 500, 'Sun Oct 18 17:00:01 2026'],
				[502, 501, 'Sun Oct 18 17:00:02 2026'],
				[600, 1, 'Sun Oct 18 17:00:03 2026']
			],
			[
				[1, 0, BOOT],
				[me, 1, BOOT],
				[501, 1, 'Sun Oct 18 17:00:09 2026'], // the PID now belongs to another process
				[502, 1, 'Sun Oct 18 17:00:02 2026'],
				[503, 502, 'Sun Oct 18 17:00:05 2026'],
				[600, 1, 'Sun Oct 18 17:00:03 2026']
			],
			[
				[1, 0, BOOT],
				[me, 1, BOOT],
				[501, 1, 'Sun Oct 18 17:00:09 2026'],
				[600, 1, 'Sun Oct 18 17:00:03 2026']
			]
		);

		const result = await killTree(500, { ps, kill, graceMs: 0 });

		expect(signals).toEqual([
			[500, 'SIGTERM'],
			[502, 'SIGKILL'],
			[503, 'SIGKILL']
		]);
		expect(result).toEqual({
			tree: [500, 501, 502, 503],
			sigkilled: [502, 503],
			left: [],
			degraded: false
		});
	});

	it('never signals init or this process, even when a corrupt table puts them below the agent', async () => {
		const { signals, kill } = recorder();
		const table: [number, number, string][] = [
			[1, 500, BOOT],
			[me, 500, BOOT],
			[500, 7, 'Sun Oct 18 17:00:00 2026']
		];
		const result = await killTree(500, { ps: psSequence(table), kill, graceMs: 0 });

		expect(signals).toEqual([
			[500, 'SIGTERM'],
			[500, 'SIGKILL']
		]);
		expect(result.tree).toEqual([500]);
		await expect(killTree(1, { kill })).rejects.toThrow('refusing');
		await expect(killTree(me, { kill })).rejects.toThrow('refusing');
		await expect(killTree(0, { kill })).rejects.toThrow('refusing');
		expect(signals).toHaveLength(2);
	});

	it.each([
		[
			'missing',
			async () => Promise.reject(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }))
		],
		['unreadable', async () => 'ps: unknown option -- o']
	])('falls back to SIGKILL for the agent alone when ps is %s', async (_case, ps) => {
		const { signals, kill } = recorder();
		const result = await killTree(500, { ps, kill, graceMs: 0 });
		expect(signals).toEqual([[500, 'SIGKILL']]);
		expect(result).toEqual({ tree: [500], sigkilled: [500], left: [], degraded: true });
	});

	it('does nothing for an agent that is gone already', async () => {
		const { signals, kill } = recorder();
		const result = await killTree(500, { ps: psSequence([[1, 0, BOOT]]), kill, graceMs: 0 });
		expect(signals).toEqual([]);
		expect(result).toEqual({ tree: [], sigkilled: [], left: [], degraded: false });
	});
});
