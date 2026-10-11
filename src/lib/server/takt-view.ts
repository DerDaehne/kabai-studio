import type { DatabaseSync } from 'node:sqlite';
import type { QueuedQuestion } from '$lib/live';
import { openQuestions, recentFinishedRuns } from './live';
import { runTracks, withWayOuts, type FinishedRunWithWayOut, type RunTrack } from './start-view';

export type TaktView = {
	questions: QueuedQuestion[];
	tracks: RunTrack[];
	finished: FinishedRunWithWayOut[];
};

/** Everything the Takt shows beyond the live state the root layout already loads, in a fixed number of queries. */
export function taktView(db: DatabaseSync, now = new Date()): TaktView {
	return {
		questions: openQuestions(db),
		tracks: runTracks(db, now),
		finished: withWayOuts(db, recentFinishedRuns(db))
	};
}
