/**
 * Opening a workspace for `seed` or `run`, and setting up a run on it.
 * Whatever an earlier run left is undone first, from its journal, and only
 * then is the fixture marker read, since an interrupted task may have edited
 * the marker itself. A run's graph is validated before its setup writes
 * anything, so a refusal leaves nothing behind, and what setup adds is
 * journaled with the snapshot, so it is removed however the run ends.
 */
import { FIXTURE_HASH_PREFIX, FIXTURE_MARKER_PAGE } from './fixture'
import { childrenOf, type GraphProbe, pageIdByTitle, sqlAll } from './graphQueries'
import { type QuietOptions, snapshotWorkspace, type WorkspaceSnapshot } from './isolation'
import type { RunJournal } from './runJournal'

/** The fixture hash the seeded graph carries, or null when it carries none. */
const seededHash = async (probe: GraphProbe): Promise<string | null> => {
  const markerId = await pageIdByTitle(probe, FIXTURE_MARKER_PAGE)
  if (!markerId) return null
  const line = (await childrenOf(probe, markerId)).find(row => row.content.startsWith(FIXTURE_HASH_PREFIX))
  return line ? line.content.slice(FIXTURE_HASH_PREFIX.length).trim() : null
}

export const openWorkspace = async (probe: GraphProbe, journal: RunJournal, fixtureHash: string, quiet?: QuietOptions) => {
  const recovered = await journal.recover(probe, fixtureHash, quiet)
  return {recovered, seeded: await seededHash(probe)}
}

/** The starting state every task of a run gets: each task's changes are
 *  undone against the snapshot this returns. */
export const beginRun = async (
  probe: GraphProbe,
  journal: RunJournal,
  fixtureHash: string,
  steps: {validate: () => Promise<void>, setUp: () => Promise<void>},
  quiet?: QuietOptions,
): Promise<{snapshot: WorkspaceSnapshot, setupCreated: string[]}> => {
  await steps.validate()
  const ids = async () => (await sqlAll<{id: string}>(probe, 'SELECT id FROM blocks WHERE workspace_id = ?', [probe.workspaceId])).map(row => row.id)
  const existing = new Set(await ids())
  await steps.setUp()
  const snapshot = await snapshotWorkspace(probe, quiet)
  const setupCreated = [...snapshot.rows.keys()].filter(id => !existing.has(id))
  journal.begin(snapshot, fixtureHash, setupCreated)
  return {snapshot, setupCreated}
}
