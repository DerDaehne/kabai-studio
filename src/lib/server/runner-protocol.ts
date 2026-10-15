// What the runner channel's two ends agree on. Dependency-free: both server.ts (runner side) and the bundle load it.
export const RUNNER_PATH = '/runner';
export const PROTOCOL_VERSION = 1;
/** Silence this long ends a connection, on either side. */
export const DEAD_AFTER_MS = 30_000;

/** WebSocket close codes in the application range (4000-4999). */
export const CLOSE = {
	badProtocol: 4400,
	revoked: 4401,
	badFrame: 4402,
	replaced: 4403
} as const;
