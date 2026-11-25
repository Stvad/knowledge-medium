import type { Tx } from '@/data/api'
import { presetIdProp } from '@/data/properties'
import { UUID_RE_SOURCE } from '@/data/referenceBlock'
import type { Repo } from '@/data/repo'
import { peekRowProperty } from '@/data/rowProperty'
import { getOrCreateDailyNoteInTx } from '@/plugins/daily-notes/dailyNotes'
import { resolveDayInput } from '@/plugins/daily-notes/dayProperty'
import { dayValuePresetCore, isDayReferenceSchema } from '@/plugins/daily-notes/schema'

const uuid = new RegExp(`^${UUID_RE_SOURCE}$`, 'i')

/** Agent bags normally contain encoded cells. Only the day preset accepts
 * calendar expressions alongside its encoded reference IDs. */
export const resolveAgentDayProperties = async (
  repo: Repo,
  tx: Tx,
  workspaceId: string,
  properties: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const definitions = repo.propertyDefinitionsFor(workspaceId)
  if (!properties || !definitions) return properties
  const resolver = repo.propertySchemaResolverFor(workspaceId)
  const snapshot = repo.snapshotTypeRegistries()
  const now = new Date()
  const encoded = {...properties}
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value !== 'string' || value === '' || uuid.test(value)) continue
    const resolved = resolver.resolve(name)
    if (resolved.status !== 'resolved' || !isDayReferenceSchema(resolved.schema)) continue

    const {fieldId} = resolved.schema
    const definition = definitions.definitionsByFieldId.get(fieldId)
    const seed = definition
      ? definition.seedKey && definitions.seedsByKey.get(definition.seedKey)
      : definitions.seedsByName.get(name)?.[0]
    const row = seed ? null : await tx.get(fieldId)
    const presetId = seed ? seed.presetId : row && peekRowProperty(row, presetIdProp)
    if (presetId !== dayValuePresetCore.id) continue

    // Preserve exact IDs of existing rows, including legacy IDs and tombstones.
    if (await tx.get(value)) continue
    const iso = resolveDayInput(value, now)
    encoded[name] = await getOrCreateDailyNoteInTx(tx, snapshot, workspaceId, iso)
  }
  return encoded
}
