import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ user: locals.user! }); // der Guard in hooks.server.ts garantiert die Session
