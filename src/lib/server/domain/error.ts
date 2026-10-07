// No imports: db.ts and restore.ts also load this directly under plain Node (no Vite, no bundler), and both the
// events.ts import and TS parameter-property shorthand break there.

/** A rule violation with a message an agent can read directly; `hint` names the way out. */
export class DomainError extends Error {
	readonly code: string;
	readonly hint: string;

	constructor(code: string, message: string, hint: string) {
		super(message);
		this.code = code;
		this.hint = hint;
		this.name = 'DomainError';
	}
}

/** Narrows to `DomainError` — for a `catch` that only swallows a rule violation, not every error. */
export function isDomainError(err: unknown): err is DomainError {
	return err instanceof DomainError;
}

/** One stderr-ready line: `[code] message hint` for a DomainError, or just the message otherwise. */
export function formatError(err: unknown): string {
	if (err instanceof DomainError) return `[${err.code}] ${err.message} ${err.hint}`;
	return err instanceof Error ? err.message : String(err);
}
