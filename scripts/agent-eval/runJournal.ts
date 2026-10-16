/**
 * Survives an interrupted run. The run's snapshot goes to disk before the
 * first task, and a mark is left while a task is between its start and its
 * restore; a run killed in that window leaves the mark, and the next run
 * restores the stored snapshot before taking its own — otherwise a stray edit
 * left behind would become part of every later run's starting graph.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GraphProbe } from './graphQueries'
import {
  loadSnapshot,
  type QuietOptions,
  restoreSnapshot,
  storeSnapshot,
  type StoredSnapshot,
  type WorkspaceSnapshot,
} from './isolation'

interface JournalSnapshot extends StoredSnapshot {
  fixtureHash: string
}

export const createRunJournal = (dir: string) => {
  const snapshotFile = path.join(dir, 'snapshot.json')
  const inFlightFile = path.join(dir, 'in-flight.json')
  const clear = () => rmSync(dir, {recursive: true, force: true})

  return {
    /** Undo what an interrupted task of an earlier run left. Returns the
     *  number of blocks restored (0 when the last run ended cleanly). */
    recover: async (probe: GraphProbe, fixtureHash: string, quiet?: QuietOptions): Promise<number> => {
      if (!existsSync(inFlightFile) || !existsSync(snapshotFile)) {
        clear()
        return 0
      }
      const journal = JSON.parse(readFileSync(snapshotFile, 'utf8')) as JournalSnapshot
      if (journal.fixtureHash !== fixtureHash) {
        clear()
        return 0
      }
      const changes = await restoreSnapshot(probe, loadSnapshot(journal), quiet)
      clear()
      return changes.created.length + changes.modified.length
    },
    begin: (snapshot: WorkspaceSnapshot, fixtureHash: string) => {
      mkdirSync(dir, {recursive: true})
      writeFileSync(snapshotFile, JSON.stringify({fixtureHash, ...storeSnapshot(snapshot)} satisfies JournalSnapshot))
    },
    taskStarted: () => writeFileSync(inFlightFile, '{}'),
    taskRestored: () => rmSync(inFlightFile, {force: true}),
    end: clear,
  }
}
