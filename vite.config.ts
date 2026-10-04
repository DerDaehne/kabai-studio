import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolveVersion } from './src/lib/version.ts';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	// Evaluated once per `vite build`/`vite dev` start — see src/lib/version.ts for the precedence.
	define: {
		__STUDIO_VERSION__: JSON.stringify(resolveVersion()),
		__STUDIO_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
	}
});
