import {
  definitionSeedsFacet,
  localSchemaFacet,
  refTargetComparablePropertiesFacet,
  systemPagesFacet,
  typeSeedsFacet,
  valuePresetCoresFacet,
} from '@/data/facets'
import type { AppExtension } from '@/facets/facet.js'
import type { ScalarPresetConversion } from '@/data/api'
import { getOrCreateDailyNoteInTx, isValidDateAlias, journalPageSpec } from './dailyNotes.ts'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType, dayValuePresetCore } from './schema.ts'

const convertDateToDay: ScalarPresetConversion = {
  from: 'date',
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

export const dailyNotesDataExtension: AppExtension = [
  valuePresetCoresFacet.of({...dayValuePresetCore, scalarConversion: convertDateToDay}, {source: 'daily-notes'}),
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
