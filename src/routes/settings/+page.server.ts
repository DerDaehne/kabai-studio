import { backupStatus, RETENTION } from '$lib/server/backup';
import { backupDir } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// ponytail: Sicherungsstatus direkt hier, bis der System-Check (#812) ihn als Prüfung in seine Registry übernimmt.
export const load: PageServerLoad = () => ({ backup: backupStatus(backupDir()), retention: RETENTION });
