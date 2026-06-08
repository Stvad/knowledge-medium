import type { LocalSchemaContribution } from '@/data/facets.js'
import { dailyNoteDateProp } from './schema.ts'

/** Always-quoted JSON path for the date property. Matches what
 *  `jsonPathForProperty` (in the typed-query compiler) emits, so the
 *  expression index below uses the same literal text the compiler
 *  produces — SQLite only matches expression indexes by literal text. */
const DAILY_NOTE_DATE_JSON_PATH = `$."${dailyNoteDateProp.name}"`

/** Partial functional index on the daily-note date property. Cheap to
 *  maintain (the property only lands on daily-note rows; the partial
 *  predicate keeps the b-tree small), turns unbounded date-range
 *  queries into b-tree seeks instead of `properties_json` JSON
 *  extracts. The motivating query is the JOIN-through-ref shape used
 *  for filters like "items whose `next-review-date` ref points to a
 *  daily note before today" — `WHERE d.daily-note:date < ?` lands
 *  here.
 *
 *  `dailyNoteDateProp` is written at daily-note creation
 *  (`getOrCreateDailyNote`), so the index stays populated without a
 *  backfill. The legacy one-shot backfill that derived the property
 *  from each row's ISO alias was dropped once the migration had run on
 *  active workspaces — it scanned/wrote across ALL workspaces at cold
 *  start (touching ones the user never opened); re-add a
 *  workspace-scoped pass if a never-migrated graph ever surfaces. */
const CREATE_DAILY_NOTE_DATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_daily_note_date
  ON blocks (json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}'))
  WHERE deleted = 0
    AND json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NOT NULL
`

export const dailyNotesLocalSchema: LocalSchemaContribution = {
  id: 'daily-notes.local-schema',
  statements: [CREATE_DAILY_NOTE_DATE_INDEX_SQL],
}
