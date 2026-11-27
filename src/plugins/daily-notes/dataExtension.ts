import {
  definitionSeedsFacet,
  localSchemaFacet,
  refTargetComparablePropertiesFacet,
  systemPagesFacet,
  typeSeedsFacet,
  valuePresetCoresFacet,
} from '@/data/facets'
import type { AppExtension } from '@/facets/facet.js'
import { faithfulWikilinkReplacement } from '@/plugins/references/referenceParser'
import { hasBlockType } from '@/data/properties'
import { referenceBlockContentForId } from '@/data/referenceBlock'
import type { ScalarPresetConversion, AnyValuePresetCore } from '@/data/api'
import { claimDailyNoteAliases, dailyNoteTitle, getOrCreateDailyNoteInTx, isValidDateAlias, journalPageSpec } from './dailyNotes.ts'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType, dayValuePresetCore, isDayReferenceSchema } from './schema.ts'

const convertDateToDay: ScalarPresetConversion = {
  from: 'date',
  matchesTarget: isDayReferenceSchema,
  async convert(encoded, ctx, sourceText) {
    if (encoded === null) return {encoded: null}
    const raw = sourceText?.trim() ?? encoded
    if (typeof raw !== 'string' || !isValidDateAlias(raw.slice(0, 10))) return {refused: 'invalid calendar date'}
    // An instant without a zone would choose a different day on another device.
    const instant = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw)
    const ms = Date.parse(raw)
    if (!instant || !Number.isFinite(ms)) return {refused: 'invalid ISO instant'}
    const date = new Date(ms).toISOString()
    if (date.slice(11) !== '00:00:00.000Z' || /[1-9]/.test(instant[2] ?? '')) return {refused: 'time of day'}
    const iso = date.slice(0, 10)
    if (!isValidDateAlias(iso)) return {refused: 'UTC year outside the daily-note range'}
    return {encoded: await getOrCreateDailyNoteInTx(ctx.tx, ctx, ctx.workspaceId, iso)}
  },
}

// Claiming a free long alias on an ISO-only daily note accepts one whole-column properties write.
const dayValueReference: NonNullable<AnyValuePresetCore['valueChildReference']> = {
  matchesSchema: isDayReferenceSchema,
  async resolve(tx, workspaceId, id) {
    const target = await tx.get(id)
    if (!target || target.deleted || target.workspaceId !== workspaceId || !hasBlockType(target, DAILY_NOTE_TYPE)) return
    const isIsoSeat = isValidDateAlias(target.content)
    const title = isIsoSeat ? dailyNoteTitle(target.content) : target.content
    const link = faithfulWikilinkReplacement(title)
    if (!link) return referenceBlockContentForId(id)
    let owner = await tx.aliasLookup(link.refAlias, workspaceId)
    if (!owner && isIsoSeat) {
      await claimDailyNoteAliases(tx, id, [link.refAlias])
      owner = await tx.aliasLookup(link.refAlias, workspaceId)
    }
    return owner?.id === id ? link.text : referenceBlockContentForId(id)
  },
}

export const dailyNotesDataExtension: AppExtension = [
  valuePresetCoresFacet.of({...dayValuePresetCore, scalarConversion: convertDateToDay, valueChildReference: dayValueReference}, {source: 'daily-notes'}),
  definitionSeedsFacet.of(dailyNoteDateProp, {source: 'daily-notes'}),
  typeSeedsFacet.of(dailyNoteType, {source: 'daily-notes'}),
  localSchemaFacet.of(dailyNotesLocalSchema, {source: 'daily-notes'}),
  // Eagerly materialise the Journal page at bootstrap so `[[Journal]]` resolves
  // to it instead of auto-creating a rival claimant (alias.collision).
  systemPagesFacet.of({spec: journalPageSpec, eager: true}, {source: 'daily-notes'}),
  refTargetComparablePropertiesFacet.of(
    {targetType: DAILY_NOTE_TYPE, property: dailyNoteDateProp.name},
    {source: 'daily-notes'},
  ),
]
