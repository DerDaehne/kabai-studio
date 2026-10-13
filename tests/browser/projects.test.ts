import { randomUUID } from 'node:crypto';
import { expect, open, test } from './fixtures.ts';
import { VARIANTS, type Variant } from '../../src/lib/server/domain/variants.ts';
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
	const steps = page.getByRole('region', { name: 'Schritte' }).getByRole('listitem');
	await expect(steps).toHaveCount(7);
	await expect(steps.first()).toContainText('Backlog');
	await expect(page.getByText('Variante Software')).toBeVisible();
	await expect(page.getByText('Do: ')).toHaveCount(0);

	await page.getByLabel('Titel').fill('Draft the landing page');
	await page.getByRole('button', { name: 'Ticket anlegen' }).click();
	await expect(page).toHaveURL(`/p/${key}/t/1`);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft the landing page');
});

const VARIANT_NAMES: Record<Variant, string> = {
	software: 'Software',
	knowledge: 'Wissen',
	direct: 'Direkt'
};

for (const variant of Object.keys(VARIANTS) as Variant[]) {
	test(`a project of the ${variant} variant gets the columns of that variant`, async ({
		page,
		db
	}) => {
		const suffix = uniqueSuffix();
		const key = `V${suffix}`;
		await open(page, '/projects');
		await page.getByLabel('Name', { exact: true }).fill(`Variant ${suffix}`);
		await page.getByLabel('Key', { exact: true }).fill(key);
		await page.getByRole('radio', { name: VARIANT_NAMES[variant] }).check();
		await page.getByRole('button', { name: 'Projekt anlegen' }).click();

		await expect(page).toHaveURL(`/p/${key}`);
		await expect(page.getByText(`Variante ${VARIANT_NAMES[variant]}`)).toBeVisible();
		const columns = db
			.prepare(
				'SELECT c.step FROM columns c JOIN projects p ON p.id = c.project_id WHERE p.key = ? ORDER BY c.position'
			)
			.all(key)
			.map((row) => row.step);
		expect(columns).toEqual([...VARIANTS[variant]]);
		await expect(page.getByRole('region', { name: 'Schritte' }).getByRole('listitem')).toHaveCount(
			VARIANTS[variant].length
		);

		await open(page, '/projects');
		await expect(page.getByRole('listitem').filter({ hasText: key })).toContainText(
			VARIANT_NAMES[variant]
		);
	});
}

test('every variant option shows its sentence, linked as its accessible description', async ({
	page
}) => {
	await open(page, '/projects');
	for (const variant of Object.keys(VARIANTS) as Variant[]) {
		const radio = page.getByRole('radio', { name: VARIANT_NAMES[variant] });
		const description = page.locator(`#variant-${variant}-description`);
		await expect(description).toBeVisible();
		await expect(radio).toHaveAttribute('aria-describedby', `variant-${variant}-description`);
		await expect(radio).toHaveAccessibleDescription(/bevor du abnimmst/);
	}
	await expect(page.getByRole('radio', { name: 'Software' })).toBeChecked();
});

test('a project of the knowledge variant can be created with the keyboard alone', async ({
	page
}) => {
	const suffix = uniqueSuffix();
	const key = `K${suffix}`;
	await open(page, '/projects');
	await page.getByLabel('Name', { exact: true }).focus();
	await page.keyboard.type(`Keyboard ${suffix}`);
	await page.keyboard.press('Tab');
	await page.keyboard.type(key);
	await page.keyboard.press('Tab');
	const software = page.getByRole('radio', { name: 'Software' });
	await expect(software).toBeFocused();
	await expect(software).toHaveCSS('outline-style', 'solid');
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('radio', { name: 'Wissen' })).toBeFocused();
	await expect(page.getByRole('radio', { name: 'Wissen' })).toBeChecked();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Enter');

	await expect(page).toHaveURL(`/p/${key}`);
	await expect(page.getByText('Variante Wissen')).toBeVisible();
});

test('an unknown variant is refused at the variant group, focused and announced, keeping the input', async ({
	page
}) => {
	const suffix = uniqueSuffix();
	await open(page, '/projects');
	await page.getByLabel('Name', { exact: true }).fill(`Chaos ${suffix}`);
	await page.getByLabel('Key', { exact: true }).fill(`X${suffix}`);
	const direct = page.getByRole('radio', { name: 'Direkt' });
	await direct.check();
	await direct.evaluate((input: HTMLInputElement) => (input.value = 'chaos'));
	await page.getByRole('button', { name: 'Projekt anlegen' }).click();

	const focused = page.locator('input[name=variant]:focus');
	await expect(focused).toHaveCount(1);
	await expect(focused).toHaveAttribute('aria-invalid', 'true');
	await expect(focused).toHaveAccessibleDescription(/Die Variante „chaos“ gibt es nicht\. Ausweg:/);
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue(`Chaos ${suffix}`);
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
