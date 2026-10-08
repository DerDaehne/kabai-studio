import { randomUUID } from 'node:crypto';
import { expect, open, test } from './fixtures.ts';
import { PROJECT } from './global-setup.ts';

// Projects cannot be deleted, so every run creates its own: capital letters and digits keep the key valid.
// 10 hex characters (hyphens stripped first) keep collisions astronomically unlikely (16^10 possibilities).
const uniqueSuffix = () => randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();

test('creating a project leads straight into it, and from there to its first ticket', async ({
	page
}) => {
	const suffix = uniqueSuffix();
	const key = `C${suffix}`;
	await open(page, '/projects');
	await page.getByLabel('Name', { exact: true }).fill(`Kundenportal ${suffix}`);
	await page.getByLabel('Key', { exact: true }).fill(key.toLowerCase());
	await page.getByRole('button', { name: 'Projekt anlegen' }).click();

	await expect(page).toHaveURL(`/p/${key}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${key} Kundenportal ${suffix}`);
	const columns = page.getByRole('region', { name: 'Spalten' }).getByRole('listitem');
	await expect(columns).toHaveCount(9);
	await expect(columns.first()).toContainText('Backlog');

	await page.getByLabel('Titel').fill('Draft the landing page');
	await page.getByRole('button', { name: 'Ticket anlegen' }).click();
	await expect(page).toHaveURL(`/p/${key}/t/1`);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft the landing page');
});

test('a taken key is refused at the key field with a way out, keeping what was typed', async ({
	page
}) => {
	const suffix = uniqueSuffix();
	await open(page, '/projects');
	const name = page.getByLabel('Name', { exact: true });
	const key = page.getByLabel('Key', { exact: true });
	await name.fill(`Second suite ${suffix}`);
	await key.fill(PROJECT.key.toLowerCase());
	await page.getByRole('button', { name: 'Projekt anlegen' }).click();

	await expect(key).toHaveAttribute('aria-invalid', 'true');
	await expect(key).toBeFocused();
	await expect(key).toHaveAccessibleDescription(
		new RegExp(`Den Key „${PROJECT.key}“ hat schon das Projekt „${PROJECT.name}“\\. Ausweg:`)
	);
	await expect(page).toHaveURL('/projects');
	await expect(name).toHaveValue(`Second suite ${suffix}`);

	await key.fill(`${PROJECT.key}${suffix}`);
	await page.getByRole('button', { name: 'Projekt anlegen' }).click();
	await expect(page).toHaveURL(`/p/${PROJECT.key}${suffix}`);
});

test('without a project the Stellwerk says so and leads to creating one', async ({ page, db }) => {
	// No project can be removed through the domain, so the test sets the active ones aside in the archive.
	const active = db
		.prepare('UPDATE projects SET archived = 1 WHERE archived = 0 RETURNING id')
		.all()
		.map((row) => row.id as number);
	try {
		await open(page, '/');
		await expect(page.getByText('Noch kein Projekt')).toBeVisible();
		await page.getByRole('link', { name: 'Projekt anlegen' }).click();
		await expect(page).toHaveURL('/projects');
		await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
	} finally {
		const restore = db.prepare('UPDATE projects SET archived = 0 WHERE id = ?');
		for (const id of active) restore.run(id);
	}
});
