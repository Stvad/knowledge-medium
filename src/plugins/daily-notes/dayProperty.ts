import { type PropertySchema, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { parseRelativeDate } from '@/utils/relativeDate'
import { dailyNoteDateValue, getOrCreateDailyNoteInTx, isDateAlias } from './dailyNotes'
import { isDayReferenceSchema } from './schema'

/** A Date names its UTC calendar day. Relative expressions use the caller's local calendar. */
export const resolveDayInput = (input: Date | string, now = new Date()): string => {
  if (input instanceof Date) {
    const iso = input.toISOString().split('T')[0]!
    dailyNoteDateValue(iso)
    return iso
  }
  const text = input.trim()
  if (isDateAlias(text)) {
    dailyNoteDateValue(text)
    return text
  }
  const parsed = parseRelativeDate(text, now)
  if (parsed) return parsed.iso
  throw new Error(`Invalid calendar day: ${text}`)
}

/** Set a day or a single daily-note reference inside the owner's transaction. */
export const setDayProperty = async (
  tx: Tx, snapshot: TypeRegistrySnapshot, ownerId: string, schema: PropertySchema<string | undefined>, input: Date | string,
): Promise<void> => {
  const resolved = await tx.resolvePropertySchema(ownerId, schema)
  if (!isDayReferenceSchema(resolved)) {
    throw new Error(`Property "${schema.name}" must reference daily notes`)
  }
  const owner = await tx.get(ownerId)
  if (!owner || owner.deleted) throw new Error('The property owner is missing or deleted')
  const target = await getOrCreateDailyNoteInTx(tx, snapshot, owner.workspaceId, resolveDayInput(input))
  await tx.setProperty(ownerId, resolved, target)
}
