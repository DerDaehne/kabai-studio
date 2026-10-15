// Preloaded with `node --import` into a CLI process: appends the URL of every module it resolves to the file named by
// RECORD_IMPORTS_TO, so a test can prove which modules a subcommand did and did not load.
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		appendFileSync(process.env.RECORD_IMPORTS_TO, `${resolved.url}\n`);
		return resolved;
	}
});
