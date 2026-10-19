import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Server rendering imports rekta.js where no document, window or navigator exists. A fresh Node process is the one
// place guaranteed to have none of them, whatever globals the test runner adds.
const script = fileURLToPath(new URL('./rekta.js', import.meta.url));

it('imports without a DOM and exports its parts', () => {
	const probe = `
		const missing = ['document', 'window', 'localStorage'].filter((name) => name in globalThis);
		if (missing.length) throw new Error('the probe has a DOM: ' + missing);
		const rekta = await import(${JSON.stringify(script)});
		console.log(['appbar', 'pivot', 'strip', 'version'].every((name) => name in rekta));
	`;
	const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
		encoding: 'utf8'
	});
	expect(output.trim()).toBe('true');
});
