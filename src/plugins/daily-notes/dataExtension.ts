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
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'
import { formatRoamDate } from '@/utils/dailyPage'
import type { ScalarPresetConversion, AnyValuePresetCore } from '@/data/api'
import { claimDailyNoteAliases, getOrCreateDailyNoteInTx, isValidDateAlias, journalPageSpec } from './dailyNotes.ts'
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

// A competing page that owns the date alias is the value, just as it is for an authored wikilink.
const dayValueReference: NonNullable<AnyValuePresetCore['valueChildReference']> = {
  matchesSchema: isDayReferenceSchema,
  async resolve(tx, workspaceId, id) {
    const target = await tx.get(id)
    if (!target || target.deleted || target.workspaceId !== workspaceId || !hasBlockType(target, DAILY_NOTE_TYPE)) return
    const title = isValidDateAlias(target.content)
      ? formatRoamDate(new Date(target.content), 'UTC') : target.content
    const link = faithfulWikilinkReplacement(title)
    if (!link) return
    let owner = await tx.aliasLookup(link.refAlias, workspaceId)
    if (!owner && isValidDateAlias(target.content)) {
      // An ISO-only daily-note seat gains its long alias on the first link that uses it.
      const isoOwner = await tx.aliasLookup(target.content, workspaceId)
      await claimDailyNoteAliases(tx, isoOwner?.id ?? id, [link.refAlias])
      owner = await tx.aliasLookup(link.refAlias, workspaceId)
    }
    if (owner && (owner.id === id || parseLiteralDailyPageTitle(title))) {
      return {content: link.text, referenceTargetId: owner.id}
    }
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
