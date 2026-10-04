// `npm run scenario -- <scenario-file> <output-dir>`: the server modules the harness drives (runner, builtin
// executor, domain layer) use SvelteKit-style extensionless imports, which plain Node cannot resolve. This
// thin entry loads them the same way vitest does — through Vite's own SSR module runner — instead of adding a
// second import style to that whole part of the codebase just for one script.
import { createServer } from 'vite';

async function main(): Promise<void> {
	const server = await createServer({
		server: { middlewareMode: true, watch: null },
		appType: 'custom',
		logLevel: 'warn'
	});
	try {
		const mod = await server.ssrLoadModule('/src/lib/server/scenario.ts');
		await mod.main();
	} finally {
		await server.close();
	}
}

main()
	.then(() => process.exit(process.exitCode ?? 0))
	.catch((err: Error) => {
		console.error(`scenario: ${err.message}`);
		process.exit(1);
	});
