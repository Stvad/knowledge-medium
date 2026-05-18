import type { LocalSchemaContribution, LocalSchemaDb } from '@/data/facets.ts'
import { dailyNoteDateProp, DAILY_NOTE_TYPE } from './schema.ts'

/** One-shot device-local backfill: for every daily-note block missing
 *  `dailyNoteDateProp`, derive the date from the row's ISO alias
 *  (`YYYY-MM-DD`) and write it into `properties_json` as the codec
 *  would. `dateCodec.encode` produces `date.toISOString()`; UTC midnight
 *  of the ISO calendar day round-trips bit-for-bit to that string, so
 *  the value we synthesise here is indistinguishable from one written
 *  through `tx.setProperty(dailyNoteDateProp, ...)`.
 *
 *  Why SQL rather than a JS scan: a workspace can carry thousands of
 *  daily-note rows (one per day x N years). The kernel-side backfill
 *  pattern (alias index, block_types) keeps cold-start cheap; this
 *  matches it. PowerSync uploads the `blocks` UPDATE via the existing
 *  upload trigger, so other devices converge through normal sync —
 *  every device that runs the backfill writes the same value, so
 *  there's no conflict to resolve.
 *
 *  Idempotent: gated on a `client_schema_state` marker, and the SQL
 *  itself only touches rows where `$.daily-note:date` is still NULL. */
const BACKFILL_MARKER_KEY = 'daily_note_date_property_backfill_v1'

const SELECT_BACKFILL_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${BACKFILL_MARKER_KEY}'
`

const RECORD_BACKFILL_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${BACKFILL_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

/** `$.${dailyNoteDateProp.name}` JSON path — the codec encodes
 *  `Date.toISOString()`, so the on-disk shape we write is the ISO
 *  alias `YYYY-MM-DD` concatenated with `T00:00:00.000Z`. The GLOB
 *  shape rejects malformed aliases (e.g. partial or non-numeric
 *  strings) so a corrupted row never gets an invalid date value. */
const BACKFILL_DAILY_NOTE_DATE_SQL = `
  UPDATE blocks
  SET properties_json = json_set(
    properties_json,
    '$.${dailyNoteDateProp.name}',
    (
      SELECT je.value || 'T00:00:00.000Z'
      FROM json_each(blocks.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      LIMIT 1
    )
  )
  WHERE deleted = 0
    AND json_extract(properties_json, '$.${dailyNoteDateProp.name}') IS NULL
    AND EXISTS (
      SELECT 1 FROM json_each(blocks.properties_json, '$.types') AS jt
      WHERE jt.value = '${DAILY_NOTE_TYPE}'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(blocks.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
`

export const backfillDailyNoteDatePropertyIfNeeded = async (
  db: LocalSchemaDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_DAILY_NOTE_DATE_SQL)
  await db.execute(RECORD_BACKFILL_DONE_SQL)
}

export const dailyNotesLocalSchema: LocalSchemaContribution = {
  id: 'daily-notes.local-schema',
  backfills: [
    {
      id: 'daily-notes.date-property-backfill',
      run: backfillDailyNoteDatePropertyIfNeeded,
    },
  ],
}

export { BACKFILL_MARKER_KEY as DAILY_NOTE_DATE_BACKFILL_MARKER_KEY }
