import { describe, expect, it } from 'vitest';
import { checkFloor, defaultFloor, floorSummary, type Floor } from './runner-floor';

const ORIGIN = 'https://studio.example';
const EXISTING = new Set(['/srv/repos/app', '/srv/repos/docs']);
const isDirectory = (path: string) => EXISTING.has(path);
const check = (raw: unknown) => checkFloor(raw, isDirectory);
const problem = (raw: unknown) => {
	const result = check(raw);
	return result.ok ? 'ok' : `${result.field}: ${result.problem}`;
};

describe('checkFloor', () => {
	it('fills in the safe defaults: one slot, the minimal environment, nothing allowed', () => {
		expect(check({ studioOrigin: ORIGIN })).toEqual({ ok: true, floor: defaultFloor(ORIGIN) });
		expect(defaultFloor(ORIGIN)).toEqual({
			studioOrigin: ORIGIN,
			slots: 1,
			envAllow: ['PATH', 'HOME', 'LANG', 'USER'],
			workspaces: {},
			agents: {},
			stdioMcp: {}
		});
	});

	it('leaves unattended runs off unless a workspace opts in', () => {
		const result = check({
			studioOrigin: ORIGIN,
			workspaces: {
				app: { path: '/srv/repos/app' },
				docs: { path: '/srv/repos/docs', unattended: true }
			}
		});

		expect(result.ok && result.floor.workspaces).toEqual({
			app: { path: '/srv/repos/app', unattended: false },
			docs: { path: '/srv/repos/docs', unattended: true }
		});
	});

	it('refuses a relative, a missing and a non-text workspace path, naming the field', () => {
		const withPath = (path: unknown) => ({ studioOrigin: ORIGIN, workspaces: { app: { path } } });

		expect(problem(withPath('repos/app'))).toBe('workspaces.app.path: pathNotAbsolute');
		expect(problem(withPath('/srv/repos/gone'))).toBe('workspaces.app.path: pathMissing');
		expect(problem(withPath(undefined))).toBe('workspaces.app.path: notText');
		expect(problem({ studioOrigin: ORIGIN, workspaces: { app: '/srv/repos/app' } })).toBe(
			'workspaces.app: notObject'
		);
	});

	it('refuses fewer than one slot and slots that are not a whole number', () => {
		for (const slots of [0, -1, 1.5, '2'])
			expect(problem({ studioOrigin: ORIGIN, slots })).toBe('slots: slots');
		expect(problem({ studioOrigin: ORIGIN, slots: 3 })).toBe('ok');
	});

	it('refuses a missing or non-http studio address, an unattended flag that is not a boolean and broken agent entries', () => {
		expect(problem({})).toBe('studioOrigin: origin');
		expect(problem({ studioOrigin: 'ftp://studio.example' })).toBe('studioOrigin: origin');
		expect(problem([])).toBe(': notObject');
		expect(
			problem({
				studioOrigin: ORIGIN,
				workspaces: { app: { path: '/srv/repos/app', unattended: 'yes' } }
			})
		).toBe('workspaces.app.unattended: notBoolean');
		expect(problem({ studioOrigin: ORIGIN, agents: { claude: { args: [] } } })).toBe(
			'agents.claude.command: notText'
		);
		expect(problem({ studioOrigin: ORIGIN, agents: { claude: { command: 'c', args: [1] } } })).toBe(
			'agents.claude.args: notTextList'
		);
		expect(problem({ studioOrigin: ORIGIN, envAllow: 'PATH' })).toBe('envAllow: notTextList');
	});

	it('keeps only the origin of the studio address', () => {
		const result = check({ studioOrigin: 'https://studio.example/settings/runners' });

		expect(result.ok && result.floor.studioOrigin).toBe(ORIGIN);
	});
});

describe('floorSummary', () => {
	it('tells studio only keys and the slot count, never a path, command, argument or variable', () => {
		const floor: Floor = {
			studioOrigin: ORIGIN,
			slots: 2,
			envAllow: ['PATH', 'SECRET_HOME'],
			workspaces: { app: { path: '/srv/repos/app', unattended: true } },
			agents: {
				claude: { command: '/opt/agents/claude-acp', args: ['--flag'], env: { MODEL: 'haiku' } }
			},
			stdioMcp: { files: '/opt/mcp/files-server' }
		};

		const summary = floorSummary(floor);

		expect(summary).toEqual({ workspaces: ['app'], agents: ['claude'], slots: 2 });
		const wire = JSON.stringify(summary);
		for (const detail of ['/srv', '/opt', '--flag', 'MODEL', 'haiku', 'SECRET_HOME', ORIGIN])
			expect(wire).not.toContain(detail);
	});
});
