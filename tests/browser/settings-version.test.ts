// resolveVersion() runs the same way here as it did in vite.config.ts's `define` for this build (no commits or
// tags happen between `npm run build` and this suite), so the expected value is never hardcoded.
import { resolveVersion } from '../../src/lib/version.ts';
import { expect, open, test } from './fixtures.ts';

test('settings shows the running version and build date', async ({ page }) => {
	await open(page, '/settings');
	const version = page.locator('.version');
	await expect(version).toContainText(`Version ${resolveVersion()}`);
	await expect(version).toContainText('Build');
});
