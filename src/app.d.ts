// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Baked in by vite.config.ts's `define`: the running version (src/lib/version.ts) and the build date,
	// shown in /settings and /api/health.
	const __STUDIO_VERSION__: string;
	const __STUDIO_BUILD_DATE__: string;

	namespace App {
		interface Error {
			/** Set only for an unexpected error (see `handleError` in hooks.server.ts) — matches the logged line. */
			id?: string;
		}
		interface Locals {
			user?: import('$lib/server/auth').User;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
