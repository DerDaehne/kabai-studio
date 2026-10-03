import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import {
	createOwner,
	createSession,
	hashPassword,
	SESSION_COOKIE
} from '../../src/lib/server/auth.ts';
import { openDb } from '../../src/lib/server/db.ts';
import { createProject } from '../../src/lib/server/domain/board.ts';

export const OWNER = { name: 'owner', password: 'browser-suite-owner' };
export const PROJECT = { key: 'WEB', name: 'Browser-Suite' };

/** The database in the fresh data directory that playwright.config.ts created for this run. */
export const studioDatabase = () => join(process.env.STUDIO_BROWSER_DATA_DIR!, 'studio.db');

/**
 * Seeds the owner and one project into the database the server has just migrated, and stores a signed-in session for
 * the tests. Runs after the web server is up; workers inherit the project id through the environment.
 */
export default async function globalSetup(config: FullConfig) {
	const db = openDb(studioDatabase());
	const owner = createOwner(db, OWNER.name, await hashPassword(OWNER.password))!;
	const project = createProject(db, { kind: 'user' }, PROJECT);
	process.env.STUDIO_BROWSER_PROJECT_ID = String(project.id);
	storeSession(config, createSession(db, owner.id));
	db.close();
	return () => rmSync(dirname(studioDatabase()), { recursive: true, force: true });
}

function storeSession(config: FullConfig, token: string) {
	const { baseURL, storageState } = config.projects[0].use;
	const cookie = {
		name: SESSION_COOKIE,
		value: token,
		domain: new URL(baseURL!).hostname,
		path: '/',
		expires: -1,
		httpOnly: true,
		secure: false,
		sameSite: 'Lax'
	};
	writeFileSync(storageState as string, JSON.stringify({ cookies: [cookie], origins: [] }));
}
