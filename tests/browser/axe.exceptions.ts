export interface AxeException {
	view: string;
	theme: 'light' | 'dark';
	width: 'phone' | 'desktop';
	ruleId: string;
	selector: string;
	reason: string;
}

/**
 * Violations `a11y.test.ts` finds today that are not XS to fix. Every entry needs a reason; once its violation is
 * fixed, remove the entry instead of leaving it stale — the list may only shrink, see the length check next to it.
 */
export const axeExceptions: AxeException[] = [];
