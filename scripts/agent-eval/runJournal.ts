/**
 * Everything a run must undo, on disk, so a run that stops any way at all —
 * finished, refused mid-run, killed — leaves the graph as it found it once
 * this run or the next one closes the journal:
 *
 * - the snapshot, written before the first task, with a mark left while a
 *   task is between its start and its restore. A run killed in that window
 *   leaves the mark, and the next run restores the snapshot before taking its
 *   own; otherwise a stray edit would become part of every later run's
 *   starting graph.
 * - the rows the run's own setup added (today's daily note, when it was
 *   missing), removed when the journal closes, so the graph does not grow by
 *   a note per run day.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type GraphProbe, purgeBlocks } from './graphQueries'
import {
  loadSnapshot,
  type QuietOptions,
  restoreSnapshot,
  storeSnapshot,
  type StoredSnapshot,
  type WorkspaceSnapshot,
} from './isolation'

/** Belongs to one paired tab (see where the runner keeps it), so whichever
 *  checkout recovers it, its snapshot is that tab's to restore. */
interface JournalSnapshot extends StoredSnapshot {
  setupCreated: string[]
}

export const createRunJournal = (dir: string) => {
  const snapshotFile = path.join(dir, 'snapshot.json')
  const inFlightFile = path.join(dir, 'in-flight.json')
  const clear = () => rmSync(dir, {recursive: true, force: true})

  return {
    /** Undo what an earlier run that did not close its journal left.
     *  Returns the number of blocks restored or removed (0 when it closed). */
    recover: async (probe: GraphProbe, quiet?: QuietOptions): Promise<number> => {
      const journal = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) as JournalSnapshot : null
      if (!journal) {
        clear()
        return 0
      }
      const changes = existsSync(inFlightFile) ? await restoreSnapshot(probe, loadSnapshot(journal), quiet) : null
      await purgeBlocks(probe, journal.setupCreated)
      clear()
      return (changes ? changes.created.length + changes.modified.length : 0) + journal.setupCreated.length
    },
    begin: (snapshot: WorkspaceSnapshot, setupCreated: readonly string[]) => {
      mkdirSync(dir, {recursive: true})
      writeFileSync(snapshotFile, JSON.stringify({...storeSnapshot(snapshot), setupCreated: [...setupCreated]} satisfies JournalSnapshot))
    },
    taskStarted: () => writeFileSync(inFlightFile, '{}'),
    taskRestored: () => rmSync(inFlightFile, {force: true}),
    /** Closes the journal after the run's last restore. */
    end: async (probe: GraphProbe, setupCreated: readonly string[]) => {
      await purgeBlocks(probe, setupCreated)
      clear()
    },
  }
}

export type RunJournal = ReturnType<typeof createRunJournal>
