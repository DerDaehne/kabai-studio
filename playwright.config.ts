import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 4300;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Workers load this file again with the runner's environment, so they find the same fresh data directory.
process.env.STUDIO_BROWSER_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'kabai-studio-browser-'));
const dataDir = process.env.STUDIO_BROWSER_DATA_DIR;

export default defineConfig({
	testDir: 'tests/browser',
	forbidOnly: !!process.env.CI,
	// All tests share one server, whose live events reach every open page; one test at a time keeps each page free of
	// events another test caused (such an event reloads the page data and cancels a client-side navigation in flight).
	workers: 1,
	reporter: 'list',
	globalSetup: './tests/browser/global-setup.ts',
	use: {
		baseURL: ORIGIN,
		storageState: join(dataDir, 'owner-session.json'),
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				// Full Chromium in its new headless mode: the headless shell never uses the back/forward cache.
				channel: 'chromium',
				launchOptions: {
					// Playwright turns the back/forward cache off; real browsers keep it on, and pages must cope with it.
					ignoreDefaultArgs: ['--disable-back-forward-cache'],
					// The Nix devshell's Chromium: the one Playwright downloads misses shared libraries on NixOS.
					executablePath: process.env.STUDIO_BROWSER_EXECUTABLE || undefined
				}
			}
		}
	],
	webServer: {
		command: 'node build',
		url: `${ORIGIN}/login`,
		env: { PORT: String(PORT), ORIGIN, STUDIO_DATA_DIR: dataDir }
	}
});
