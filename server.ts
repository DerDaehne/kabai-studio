// Production entry point: `node server.ts` instead of `node build` (Dockerfile, CLAUDE.md).
//
// adapter-node's handler.js reads ORIGIN at import time, at the top of the module — before
// `hooks.server.ts`'s `init` hook ever runs. A default set there (like the existing HOST default,
// which works because index.js reads HOST only afterwards) would already be too late for ORIGIN.
// So this default has to run before build/index.js (and with it handler.js) is imported at all.
//
// The origin's host must be the same string the browser's address bar uses, not whatever address
// it happens to resolve to: adapter-node (like the browser's Origin header) compares origins as
// plain strings, never resolved IPs — "localhost" can resolve to ::1 on one machine and 127.0.0.1
// on another, so defaulting it to a fixed "127.0.0.1" origin would mismatch on the ::1 ones.
const LOOPBACK_ORIGIN_HOST: Record<string, string> = {
	'': '127.0.0.1',
	'127.0.0.1': '127.0.0.1',
	localhost: 'localhost',
	'::1': '[::1]' // bracketed: URL syntax for a literal IPv6 host
};

export type OriginDecision =
	| { kind: 'keep' } // ORIGIN is already set explicitly — never overwritten
	| { kind: 'default'; origin: string } // loopback bind — safe to default
	| { kind: 'error'; message: string }; // not a loopback bind, and no ORIGIN to fall back to

/** Pure so it can be unit-tested without starting a server; `main()` below applies the result. */
export function decideOrigin(env: Record<string, string | undefined>): OriginDecision {
	if (env.ORIGIN) return { kind: 'keep' };
	const host = (env.HOST ?? '').trim().toLowerCase();
	const port = env.PORT || '3000';
	const originHost = LOOPBACK_ORIGIN_HOST[host];
	if (originHost !== undefined) return { kind: 'default', origin: `http://${originHost}:${port}` };
	return {
		kind: 'error',
		message:
			`kabai studio: HOST=${host} ist kein Loopback-Bind, und ORIGIN ist nicht gesetzt.\n` +
			'Ohne ORIGIN weist SvelteKits CSRF-Schutz Setup, Login und Logout mit einer generischen ' +
			'Fehlermeldung ab, weil adapter-node sonst https statt http annimmt.\n' +
			`Ausweg: mit ORIGIN=http://<von außen erreichbare Adresse>:${port} neu starten — ` +
			'genau der Adresse, unter der der Browser den Server erreicht.'
	};
}

async function main() {
	const decision = decideOrigin(process.env);
	if (decision.kind === 'default') process.env.ORIGIN = decision.origin;
	else if (decision.kind === 'error') {
		console.error(decision.message);
		process.exitCode = 1;
		return;
	}
	// A plain string constant, not a literal in the import() call: build/ only exists after `npm run
	// build` (svelte-check runs before it in CI), and a literal specifier would make it resolve the
	// module for types right now and fail.
	const entry = './build/index.js';
	await import(entry);
}

if (import.meta.main) await main();
