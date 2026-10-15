import { join } from 'node:path';

/**
 * The OS-conventional per-user data directory for an app named `name`: `$XDG_DATA_HOME` (falling
 * back to `~/.local/share`) on Linux and other non-Apple platforms, `~/Library/Application
 * Support` on macOS. Pure so the CLI's "start without any config" path is testable without a real
 * home directory. Node builtins only: server.ts loads this file at runtime, outside the bundle.
 */
export function defaultDataDir(
	platform: string,
	env: Record<string, string | undefined>,
	name = 'kabai-studio'
): string {
	const home = env.HOME || '';
	if (platform === 'darwin') return join(home, 'Library', 'Application Support', name);
	return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), name);
}

/**
 * The OS-conventional per-user config directory for `name`: `$XDG_CONFIG_HOME` (falling back to `~/.config`) on Linux
 * and other non-Apple platforms, `~/Library/Application Support` on macOS. Pure like `defaultDataDir`.
 */
export function defaultConfigDir(
	platform: string,
	env: Record<string, string | undefined>,
	name = 'kabai-studio'
): string {
	const home = env.HOME || '';
	if (platform === 'darwin') return join(home, 'Library', 'Application Support', name);
	return join(env.XDG_CONFIG_HOME || join(home, '.config'), name);
}
