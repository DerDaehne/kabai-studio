// The local floor of a runner machine (runner.json): which workspaces, agent commands and stdio MCP servers the machine
// allows, the environment it passes on and how many runs it takes at once. It lives only on the machine; studio can
// neither read nor change it and learns only `floorSummary`. Node builtins only: server.ts loads this file directly.
import { isAbsolute } from 'node:path';

export type Workspace = { path: string; unattended: boolean };
export type AgentCommand = { command: string; args: string[]; env: Record<string, string> };
export type Floor = {
	studioOrigin: string;
	slots: number;
	envAllow: string[];
	workspaces: Record<string, Workspace>;
	agents: Record<string, AgentCommand>;
	stdioMcp: Record<string, string>;
};
export type FloorSummary = { workspaces: string[]; agents: string[]; slots: number };

export type FloorProblem =
	| 'notObject'
	| 'notText'
	| 'notBoolean'
	| 'notTextList'
	| 'pathNotAbsolute'
	| 'pathMissing'
	| 'slots'
	| 'origin';
export type FloorCheck =
	{ ok: true; floor: Floor } | { ok: false; field: string; problem: FloorProblem };

export const DEFAULT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'USER'];

/** What pairing writes when there is no runner.json yet: nothing allowed but one slot. */
export const defaultFloor = (studioOrigin: string): Floor => ({
	studioOrigin,
	slots: 1,
	envAllow: [...DEFAULT_ENV_ALLOW],
	workspaces: {},
	agents: {},
	stdioMcp: {}
});

/** The only part of the floor studio ever learns: keys and the slot count, never a path, command or variable. */
export const floorSummary = (floor: Floor): FloorSummary => ({
	workspaces: Object.keys(floor.workspaces),
	agents: Object.keys(floor.agents),
	slots: floor.slots
});

class FloorInvalid extends Error {
	readonly field: string;
	readonly problem: FloorProblem;

	constructor(field: string, problem: FloorProblem) {
		super(`${field}: ${problem}`);
		this.field = field;
		this.problem = problem;
	}
}

/**
 * Checks parsed runner.json content and fills in the safe defaults; the first broken field ends the check. Pure:
 * `isDirectory` is its only look at the file system.
 */
export function checkFloor(raw: unknown, isDirectory: (path: string) => boolean): FloorCheck {
	try {
		return { ok: true, floor: parseFloor(raw, isDirectory) };
	} catch (err) {
		if (!(err instanceof FloorInvalid)) throw err;
		return { ok: false, field: err.field, problem: err.problem };
	}
}

function parseFloor(raw: unknown, isDirectory: (path: string) => boolean): Floor {
	const root = record(raw, '');
	return {
		studioOrigin: origin(root.studioOrigin, 'studioOrigin'),
		slots: slots(root.slots ?? 1, 'slots'),
		envAllow: textList(root.envAllow ?? DEFAULT_ENV_ALLOW, 'envAllow'),
		workspaces: entries(root.workspaces, 'workspaces', (value, field) =>
			workspace(value, field, isDirectory)
		),
		agents: entries(root.agents, 'agents', agent),
		stdioMcp: entries(root.stdioMcp, 'stdioMcp', text)
	};
}

function workspace(
	value: unknown,
	field: string,
	isDirectory: (path: string) => boolean
): Workspace {
	const fields = record(value, field);
	const path = text(fields.path, `${field}.path`);
	if (!isAbsolute(path)) throw new FloorInvalid(`${field}.path`, 'pathNotAbsolute');
	if (!isDirectory(path)) throw new FloorInvalid(`${field}.path`, 'pathMissing');
	return { path, unattended: boolean(fields.unattended ?? false, `${field}.unattended`) };
}

function agent(value: unknown, field: string): AgentCommand {
	const fields = record(value, field);
	return {
		command: text(fields.command, `${field}.command`),
		args: textList(fields.args ?? [], `${field}.args`),
		env: entries(fields.env, `${field}.env`, text)
	};
}

/** An object whose every value `check` accepts; missing counts as empty. */
function entries<T>(
	value: unknown,
	field: string,
	check: (value: unknown, field: string) => T
): Record<string, T> {
	const fields = record(value ?? {}, field);
	return Object.fromEntries(
		Object.entries(fields).map(([key, entry]) => [key, check(entry, `${field}.${key}`)])
	);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value === 'object' && value !== null && !Array.isArray(value))
		return value as Record<string, unknown>;
	throw new FloorInvalid(field, 'notObject');
}

function text(value: unknown, field: string): string {
	if (typeof value === 'string' && value.trim() !== '') return value;
	throw new FloorInvalid(field, 'notText');
}

function textList(value: unknown, field: string): string[] {
	if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== ''))
		return value;
	throw new FloorInvalid(field, 'notTextList');
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value === 'boolean') return value;
	throw new FloorInvalid(field, 'notBoolean');
}

function slots(value: unknown, field: string): number {
	if (Number.isInteger(value) && (value as number) >= 1) return value as number;
	throw new FloorInvalid(field, 'slots');
}

function origin(value: unknown, field: string): string {
	const url = URL.parse(typeof value === 'string' ? value : '');
	if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return url.origin;
	throw new FloorInvalid(field, 'origin');
}
