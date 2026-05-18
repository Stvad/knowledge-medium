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

/** Always-quoted JSON path for the date property. Matches what
 *  `jsonPathForProperty` (in the typed-query compiler) emits, so the
 *  expression index below uses the same literal text the compiler
 *  produces — SQLite only matches expression indexes by literal text. */
const DAILY_NOTE_DATE_JSON_PATH = `$."${dailyNoteDateProp.name}"`

/** `$.${dailyNoteDateProp.name}` JSON path — the codec encodes
 *  `Date.toISOString()`, so the on-disk shape we write is the ISO
 *  alias `YYYY-MM-DD` concatenated with `T00:00:00.000Z`.
 *
 *  Calendar validity is enforced via `date(je.value) = je.value`:
 *  SQLite's `date()` returns NULL for unparseable input and rolls
 *  bad calendar dates over to the normalized real date (`2026-02-30`
 *  → `2026-03-02`), so the round-trip equality is `true` only for
 *  real `YYYY-MM-DD` calendar days. Legacy rows whose only date-
 *  shaped alias is invalid (`2026-13-01`, `2026-02-30`) — possible
 *  before the references processor moved to `isValidDateAlias` —
 *  are left without the property rather than seeded with a value the
 *  date codec can't decode. */
const BACKFILL_DAILY_NOTE_DATE_SQL = `
  UPDATE blocks
  SET properties_json = json_set(
    properties_json,
    '${DAILY_NOTE_DATE_JSON_PATH}',
    (
      SELECT je.value || 'T00:00:00.000Z'
      FROM json_each(blocks.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(je.value) = je.value
      LIMIT 1
    )
  )
  WHERE deleted = 0
    AND json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NULL
    AND EXISTS (
      SELECT 1 FROM json_each(blocks.properties_json, '$.types') AS jt
      WHERE jt.value = '${DAILY_NOTE_TYPE}'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(blocks.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(je.value) = je.value
    )
`

const SELECT_HAS_ANY_BLOCKS_SQL = `SELECT 1 FROM blocks LIMIT 1`

/** Partial functional index on the daily-note date property. Cheap to
 *  maintain (the property only lands on daily-note rows; the partial
 *  predicate keeps the b-tree small), turns unbounded date-range
 *  queries into b-tree seeks instead of `properties_json` JSON
 *  extracts. The motivating query is the JOIN-through-ref shape used
 *  for filters like "items whose `next-review-date` ref points to a
 *  daily note before today" — `WHERE d.daily-note:date < ?` lands
 *  here. */
const CREATE_DAILY_NOTE_DATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_daily_note_date
  ON blocks (json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}'))
  WHERE deleted = 0
    AND json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NOT NULL
`

export const backfillDailyNoteDatePropertyIfNeeded = async (
  db: LocalSchemaDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_DAILY_NOTE_DATE_SQL)
  // Only seal the marker once the local blocks table has *something*
  // to scan. PowerSync's local-schema bootstrap runs this before
  // `db.connect()`, so a fresh device joining an existing workspace
  // would otherwise mark the migration complete against an empty
  // table — and the legacy daily-note rows that stream in via sync
  // afterwards would never get backfilled. Deferring the seal means
  // an empty workspace re-runs the (cheap, no-rows) UPDATE on each
  // cold start until rows exist, then seals.
  const hasBlocks = await db.getOptional<{1: number}>(SELECT_HAS_ANY_BLOCKS_SQL)
  if (hasBlocks === null) return
  await db.execute(RECORD_BACKFILL_DONE_SQL)
}

export const dailyNotesLocalSchema: LocalSchemaContribution = {
  id: 'daily-notes.local-schema',
  statements: [CREATE_DAILY_NOTE_DATE_INDEX_SQL],
  backfills: [
    {
      id: 'daily-notes.date-property-backfill',
      run: backfillDailyNoteDatePropertyIfNeeded,
    },
  ],
}

export { BACKFILL_MARKER_KEY as DAILY_NOTE_DATE_BACKFILL_MARKER_KEY }
