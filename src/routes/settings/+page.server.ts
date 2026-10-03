import { backupStatus, RETENTION } from '$lib/server/backup';
import { backupDir } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// ponytail: the backup status is read right here until a system check takes it over as one of its checks.
export const load: PageServerLoad = () => ({
	backup: backupStatus(backupDir()),
	retention: RETENTION
});
