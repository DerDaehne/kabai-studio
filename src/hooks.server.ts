import type { ServerInit } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export const init: ServerInit = () => {
	db(); // öffnet die DB und migriert — einmal beim Start, Fehler brechen den Start ab
};
