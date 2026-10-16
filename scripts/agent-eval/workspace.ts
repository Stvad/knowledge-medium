/**
 * Opening a workspace for `seed` or `run`: whatever an earlier run left is
 * undone first, from its journal, and only then is the fixture marker read,
 * since an interrupted task may have edited the marker itself.
 */
import { FIXTURE_HASH_PREFIX, FIXTURE_MARKER_PAGE } from './fixture'
import { childrenOf, type GraphProbe, pageIdByTitle } from './graphQueries'
import type { QuietOptions } from './isolation'
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
