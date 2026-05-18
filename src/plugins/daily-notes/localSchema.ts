import type { LocalSchemaContribution, LocalSchemaDb } from '@/data/facets.ts'
import { dailyNoteDateProp, DAILY_NOTE_TYPE } from './schema.ts'

/** Device-local maintenance for `dailyNoteDateProp`: every cold-start
 *  pass checks whether any live daily-note rows still lack the
 *  property and, if so, derives the date from each row's ISO alias
 *  and writes it into `properties_json` as the codec would.
 *  `dateCodec.encode` produces `date.toISOString()`; UTC midnight of
 *  the ISO calendar day round-trips bit-for-bit to that string, so the
 *  value we synthesise here is indistinguishable from one written
 *  through `tx.setProperty(dailyNoteDateProp, ...)`.
 *
 *  Why not a one-shot marker-gated migration: a fresh device joining
 *  an existing workspace can run the local-schema phase against a
 *  partially-synced `blocks` table (PowerSync's bootstrap runs before
 *  `db.connect()` completes the catch-up). A marker recorded then
 *  would never re-trigger when the rest of the legacy daily-note rows
 *  stream in afterwards. Re-checking every cold start sidesteps that
 *  race entirely; the cost is bounded by the number of daily-note
 *  rows in the workspace (via the `block_types` side-table probe), so
 *  the steady-state pass is sub-millisecond when nothing needs work.
 *
 *  Why SQL rather than a JS scan: a workspace can carry thousands of
 *  daily-note rows (one per day x N years). PowerSync uploads the
 *  `blocks` UPDATE via the existing upload trigger, so other devices
 *  converge through normal sync — every device that runs the backfill
 *  writes the same value, so there's no conflict to resolve. */

/** Always-quoted JSON path for the date property. Matches what
 *  `jsonPathForProperty` (in the typed-query compiler) emits, so the
 *  expression index below uses the same literal text the compiler
 *  produces — SQLite only matches expression indexes by literal text. */
const DAILY_NOTE_DATE_JSON_PATH = `$."${dailyNoteDateProp.name}"`

/** Cheap "is there pending work?" probe. Bound by the indexed
 *  `block_types` side table so we never JSON-scan non-daily-note
 *  rows — `LIMIT 1` exits on the first match. Steady state (every
 *  daily note already has the property) costs at most one full pass
 *  through the daily-note rows; with ~1k-3k daily notes that's
 *  microseconds. */
const SELECT_HAS_PENDING_DAILY_NOTE_DATE_BACKFILL_SQL = `
  SELECT 1
  FROM block_types bt
  JOIN blocks b ON b.id = bt.block_id
  WHERE bt.type = '${DAILY_NOTE_TYPE}'
    AND b.deleted = 0
    AND json_extract(b.properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NULL
    AND EXISTS (
      SELECT 1 FROM json_each(b.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(je.value) = je.value
    )
  LIMIT 1
`

/** Calendar validity is enforced via `date(je.value) = je.value`:
 *  SQLite's `date()` returns NULL for unparseable input and rolls
 *  bad calendar dates over to the normalized real date (`2026-02-30`
 *  → `2026-03-02`), so the round-trip equality is `true` only for
 *  real `YYYY-MM-DD` calendar days. Legacy rows whose only date-
 *  shaped alias is invalid (`2026-13-01`, `2026-02-30`) — possible
 *  before the references processor moved to `isValidDateAlias` — are
 *  left without the property rather than seeded with a value the
 *  date codec can't decode.
 *
 *  Candidate set is bound via the `block_types` side-table lookup so
 *  the planner doesn't have to JSON-scan every workspace block just
 *  to find the daily-note ones. */
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
  WHERE id IN (
    SELECT bt.block_id FROM block_types bt
    WHERE bt.type = '${DAILY_NOTE_TYPE}'
  )
    AND deleted = 0
    AND json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NULL
    AND EXISTS (
      SELECT 1 FROM json_each(blocks.properties_json, '$.alias') AS je
      WHERE je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(je.value) = je.value
    )
`

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
  const pending = await db.getOptional<{1: number}>(SELECT_HAS_PENDING_DAILY_NOTE_DATE_BACKFILL_SQL)
  if (pending === null) return
  await db.execute(BACKFILL_DAILY_NOTE_DATE_SQL)
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
