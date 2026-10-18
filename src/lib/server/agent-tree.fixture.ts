// Test agents for the tree kill: a Node process with a child, a grandchild and a child in a session of its own (setsid),
// the way agents start shell commands that leave their process group. Plain Node processes, no shell tools, so the
// tests run on Linux and macOS alike.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processTable, type ProcessEntry } from './tree-kill';

export type AgentTree = { agent: number; child: number; grandchild: number; detached: number };

let scripts: { dir: string; hold: string; agent: string } | undefined;

function writeScripts() {
	const dir = mkdtempSync(join(tmpdir(), 'studio-agent-tree-'));
	const hold = join(dir, 'hold.cjs');
	const child = join(dir, 'child.cjs');
	const agent = join(dir, 'agent.cjs');
	writeFileSync(hold, 'setInterval(() => {}, 1000);\n');
	writeFileSync(
		child,
		`const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, [${JSON.stringify(hold)}], { stdio: 'ignore' });
process.stdout.write(String(grandchild.pid));
setInterval(() => {}, 1000);
`
	);
	writeFileSync(
		agent,
		`const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ['ignore', 'pipe', 'ignore'] });
const detached = spawn(process.execPath, [${JSON.stringify(hold)}], { detached: true, stdio: 'ignore' });
child.stdout.once('data', (grandchild) =>
	process.stdout.write(JSON.stringify({ child: child.pid, grandchild: Number(grandchild), detached: detached.pid }) + '\\n')
);
setInterval(() => {}, 1000);
`
	);
	return { dir, hold, agent };
}

const handles: ChildProcess[] = [];
/** Every process a test started, with its start time, so the cleanup never signals a PID that was reused since. */
const started: ProcessEntry[] = [];

async function track(pids: number[]) {
	const table = await processTable();
	if (!table) throw new Error('these tests need ps');
	for (const pid of pids) {
		const entry = table.get(pid);
		if (entry) started.push(entry);
	}
}

/** Starts a test agent and resolves once its whole tree runs. */
export async function startAgentTree(): Promise<AgentTree> {
	scripts ??= writeScripts();
	const agent = spawn(process.execPath, [scripts.agent], { stdio: ['ignore', 'pipe', 'inherit'] });
	handles.push(agent);
	const line = await new Promise<string>((resolve, reject) => {
		agent.stdout!.once('data', (data: Buffer) => resolve(data.toString()));
		agent.once('exit', () => reject(new Error('the test agent ended before its tree was up')));
	});
	const tree = { agent: agent.pid!, ...(JSON.parse(line) as Omit<AgentTree, 'agent'>) };
	await track(Object.values(tree));
	return tree;
}

/** A process outside every agent tree. */
export async function startOutsider(): Promise<number> {
	scripts ??= writeScripts();
	const outsider = spawn(process.execPath, [scripts.hold], { stdio: 'ignore' });
	handles.push(outsider);
	await track([outsider.pid!]);
	return outsider.pid!;
}

/** The processes of the tree that still run. */
export async function aliveOf(tree: AgentTree): Promise<number[]> {
	const table = await processTable();
	if (!table) throw new Error('these tests need ps');
	return Object.values(tree).filter((pid) => {
		const entry = started.find((known) => known.pid === pid);
		return entry !== undefined && table.get(pid)?.started === entry.started;
	});
}

/** Ends whatever a test left running, also after a failure; call it from afterEach. */
export async function endTestProcesses(): Promise<void> {
	const table = await processTable();
	for (const entry of started.splice(0))
		if (table?.get(entry.pid)?.started === entry.started) process.kill(entry.pid, 'SIGKILL');
	for (const handle of handles.splice(0)) handle.kill('SIGKILL');
}

/** Removes the scripts; call it from afterAll. */
export function removeAgentScripts(): void {
	if (scripts) rmSync(scripts.dir, { recursive: true, force: true });
	scripts = undefined;
}
