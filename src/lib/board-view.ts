/** The cookie that remembers the expert view, so the server renders the chosen view right away. */
export const FLOW_COOKIE = 'studio-board-view';

/** Keeps the choice for every page; an older cookie for /board alone would outrank it there, so it goes. */
export function rememberFlowChoice(flow: boolean) {
	document.cookie = `${FLOW_COOKIE}=; path=/board; max-age=0`;
	document.cookie = `${FLOW_COOKIE}=${flow ? 'flow' : 'lage'}; path=/; max-age=31536000; samesite=lax`;
}

/** What the board shows becomes the choice of every page, once, so the Run-Akte follows a cookie set before it existed. */
export function moveFlowChoiceToRoot(flow: boolean) {
	if (document.cookie.includes(`${FLOW_COOKIE}=`)) rememberFlowChoice(flow);
}
