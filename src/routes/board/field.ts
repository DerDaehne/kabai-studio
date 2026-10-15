/** Escape leaves the field, so the board's keys work again. */
export const escapeTo = (leave: () => void) => (event: KeyboardEvent) => {
	if (event.key !== 'Escape') return;
	event.preventDefault();
	leave();
};

export const focusField = (input: HTMLInputElement) => {
	input.focus();
	input.select();
};
