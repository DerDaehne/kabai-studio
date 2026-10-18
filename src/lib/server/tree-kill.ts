// Ends an agent together with every process it started, also those that left its session (setsid): once the agent is
// gone they hang from PID 1 and no ppid leads to them any more, so the tree is captured before the first signal. A
// process group would miss them. Linux and macOS alike through ps, no /proc. Node builtins only: server.ts loads this
// file directly, without Vite.
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

/** How long the agent may end its tree itself after SIGTERM before every survivor gets SIGKILL. */
export const KILL_GRACE_MS = 2_000;
const SETTLE_CHECKS = 10;
const SETTLE_INTERVAL_MS = 100;

/** A process as ps lists it; `started` tells it apart from a later process that got the same PID. */
export type ProcessEntry = { pid: number; ppid: number; started: string };
export type ProcessTable = Map<number, ProcessEntry>;
export type TreeKill = {
	/** The agent and its descendants: captured before SIGTERM, plus what the survivors started meanwhile. */
	tree: number[];
	sigkilled: number[];
	/** Processes of the tree still alive after SIGKILL. */
	left: number[];
	/** ps was missing or failed, so only the agent itself got SIGKILL. */
	degraded: boolean;
};
export type TreeKillOptions = {
	/** The output of `ps -A -o pid=,ppid=,stat=,lstart=`; tests hand in their own. */
	ps?: () => Promise<string>;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	graceMs?: number;
};

const run = promisify(execFile);
const listProcesses = async () =>
	(
		await run('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], {
			env: { ...process.env, LC_ALL: 'C' },
			maxBuffer: 16 * 1024 * 1024
		})
	).stdout;

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/;

function parseProcesses(output: string): ProcessTable {
	const table: ProcessTable = new Map();
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		const match = PS_LINE.exec(line);
		if (!match) throw new Error(`unexpected ps line: ${line}`);
		const [, pid, ppid, stat, started] = match;
		if (stat.startsWith('Z')) continue; // a zombie has ended already, only its parent has not reaped it yet
		table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), started });
	}
	if (table.size === 0) throw new Error('ps listed no process');
	return table;
}

/** Every process right now, or undefined when ps is missing or fails. */
export async function processTable(ps = listProcesses): Promise<ProcessTable | undefined> {
	try {
		return parseProcesses(await ps());
	} catch {
		return undefined;
	}
}

function descendantsOf(table: ProcessTable, roots: number[]): ProcessEntry[] {
	const children = Map.groupBy(table.values(), (entry) => entry.ppid);
	const seen = new Set(roots);
	const found: ProcessEntry[] = [];
	for (let i = 0, queue = [...roots]; i < queue.length; i++)
		for (const child of children.get(queue[i]) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			found.push(child);
			queue.push(child.pid);
		}
	return found;
}

/** Never init (or the kernel), never this process: a corrupt table or a reused PID must not reach either. */
const mayKill = (pid: number) => pid > 1 && pid !== process.pid;
const isStill = (table: ProcessTable, entry: ProcessEntry) =>
	table.get(entry.pid)?.started === entry.started;

const ending = new Map<number, Promise<TreeKill>>();

/**
 * Ends the agent `pid` and its whole tree: SIGTERM to the agent, then after the grace SIGKILL to every captured process
 * still alive with an unchanged start time, and to what those started meanwhile. A second call for the same agent while
 * one runs gets that one's result instead of signalling again (the dead-man and a cancel can fire together).
 */
export function killTree(pid: number, options: TreeKillOptions = {}): Promise<TreeKill> {
	if (!mayKill(pid)) return Promise.reject(new Error(`refusing to end process ${pid}`));
	const running = ending.get(pid);
	if (running) return running;
	const end = endTree(pid, options).finally(() => ending.delete(pid));
	ending.set(pid, end);
	return end;
}

type Signal = (pid: number, name: NodeJS.Signals) => boolean;

/** Signals `pid` unless it is init or this process; false when the process is gone (ESRCH) or not ours (EPERM). */
const signaller =
	(kill: NonNullable<TreeKillOptions['kill']>): Signal =>
	(pid, name) => {
		if (!mayKill(pid)) return false;
		try {
			kill(pid, name);
			return true;
		} catch {
			return false;
		}
	};

const killAgentAlone = (pid: number, signal: Signal): TreeKill => ({
	tree: [pid],
	sigkilled: signal(pid, 'SIGKILL') ? [pid] : [],
	left: [],
	degraded: true
});

async function endTree(
	pid: number,
	{
		ps = listProcesses,
		kill = process.kill.bind(process),
		graceMs = KILL_GRACE_MS
	}: TreeKillOptions
): Promise<TreeKill> {
	const signal = signaller(kill);
	const before = await processTable(ps);
	if (!before) return killAgentAlone(pid, signal);
	const agent = before.get(pid);
	if (!agent) return { tree: [], sigkilled: [], left: [], degraded: false };
	const captured = [agent, ...descendantsOf(before, [pid])].filter((entry) => mayKill(entry.pid));
	signal(pid, 'SIGTERM');

	await sleep(graceMs);
	const after = await processTable(ps);
	if (!after) return killAgentAlone(pid, signal);
	const survivors = captured.filter((entry) => isStill(after, entry));
	const startedMeanwhile = descendantsOf(
		after,
		survivors.map((entry) => entry.pid)
	).filter((entry) => mayKill(entry.pid) && !captured.some((known) => known.pid === entry.pid));
	const doomed = [...survivors, ...startedMeanwhile];
	const sigkilled = doomed.filter((entry) => signal(entry.pid, 'SIGKILL'));
	return {
		tree: [...captured, ...startedMeanwhile].map((entry) => entry.pid),
		sigkilled: sigkilled.map((entry) => entry.pid),
		left: await stillAlive(ps, doomed),
		degraded: false
	};
}

/** SIGKILL is not instant: give the processes a moment to go before calling them left over. */
async function stillAlive(ps: () => Promise<string>, doomed: ProcessEntry[]): Promise<number[]> {
	let alive = doomed;
	for (let check = 0; alive.length && check < SETTLE_CHECKS; check++) {
		await sleep(SETTLE_INTERVAL_MS);
		const table = await processTable(ps);
		if (table) alive = alive.filter((entry) => isStill(table, entry));
	}
	return alive.map((entry) => entry.pid);
}
