/** The controls the bar may move into "more": those with a `data-rk-priority`; the rest never move. */
const MOVABLE = ':scope > .rk-ab[data-rk-priority]';

/** Lowest priority first; of equal priority the one further along the bar goes first. */
function leastImportantFirst(controls: HTMLElement[]): HTMLElement[] {
	const priority = (control: HTMLElement) => Number(control.dataset.rkPriority);
	return controls
		.map((control, index) => ({ control, index }))
		.sort((a, b) => priority(a.control) - priority(b.control) || b.index - a.index)
		.map(({ control }) => control);
}

/**
 * Moves controls into "more" until the bar fits its width, and returns the ones it moved in bar order
 * (`data-rk-overflow`, which Rekta's stylesheet hides). Measuring is ours: the bar's contents are `flex: none`, so a bar that is too narrow
 * scrolls wider than it is.
 */
export function fitAppBar(bar: HTMLElement, more: HTMLElement): HTMLElement[] {
	const controls = [...bar.querySelectorAll<HTMLElement>(MOVABLE)];
	for (const control of controls) control.removeAttribute('data-rk-overflow');
	const fits = () => bar.scrollWidth <= bar.clientWidth + 1;
	more.hidden = true;
	if (fits()) return [];
	more.hidden = false;
	for (const control of leastImportantFirst(controls)) {
		if (fits()) break;
		control.setAttribute('data-rk-overflow', '');
	}
	return controls.filter((control) => control.hasAttribute('data-rk-overflow'));
}
