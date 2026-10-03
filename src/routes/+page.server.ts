import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ user: locals.user! }); // the guard in hooks.server.ts guarantees the session
