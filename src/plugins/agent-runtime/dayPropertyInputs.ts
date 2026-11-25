import type { Tx } from '@/data/api'
import { UUID_RE_SOURCE } from '@/data/referenceBlock'
import type { Repo } from '@/data/repo'
import { getOrCreateDailyNoteInTx } from '@/plugins/daily-notes/dailyNotes'
import { resolveDayInput } from '@/plugins/daily-notes/dayProperty'
import { isDayReferenceSchema } from '@/plugins/daily-notes/schema'

const uuid = new RegExp(`^${UUID_RE_SOURCE}$`, 'i')

/** Agent bags contain encoded cells. A single-reference schema targeting daily notes
 * also accepts a calendar expression. */
export const resolveAgentDayProperties = async (
  repo: Repo,
  tx: Tx,
  workspaceId: string,
  properties: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  if (!properties) return properties
  const resolver = repo.propertySchemaResolverFor(workspaceId)
  const snapshot = repo.snapshotTypeRegistries()
  const now = new Date()
  const encoded = {...properties}
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value !== 'string' || value === '' || uuid.test(value)) continue
    const resolved = resolver.resolve(name)
    if (resolved.status !== 'resolved' || !isDayReferenceSchema(resolved.schema)) continue

    // Preserve exact IDs of existing rows, including legacy IDs and tombstones.
    if (await tx.get(value)) continue
    const iso = resolveDayInput(value, now)
    encoded[name] = await getOrCreateDailyNoteInTx(tx, snapshot, workspaceId, iso)
  }
  return encoded
}
