import { ChangeScope } from '@/data/api'
import type { WorkspaceBackfill } from '@/data/facets'
import { dailyNoteDateValue } from './dailyNotes.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from './schema.ts'

/**
 * Workspace-scoped restore of the `daily-note:date` property for pre-existing
 * daily notes — the indexable calendar-day value the query layer needs (see
 * `dailyNoteDateProp`). New daily notes get it at creation
 * (`getOrCreateDailyNote` / `ensureDailyNoteTarget`); this catches rows created
 * before the property existed.
 *
 * History: the original backfill (added 2026-05-18) ran as a raw
 * `db.execute('UPDATE blocks …')` from a LocalSchema backfill, which leaves
 * `tx_context.source = NULL` — so the source-gated upload trigger never fired
 * and the derived property never reached the server or any other client. It
 * was removed in 8c50f167 on the false premise that "it ran, so it synced." It
 * never synced, on any client. It was restored the correct way in ef0ad445: a
 * `WorkspaceBackfill` whose writes go through `repo.tx` (source='user'), so the
 * server and every client converge.
 *
 * Regression (2026-06-16): the write path is sound — it uploads (proven by the
 * `ps_crud` test below) — but the run is gated by a one-shot marker
 * (`workspace_backfill:<ws>:<id>` in `client_schema_state`). On graphs that ran
 * the ef0ad445 backfill while the rows still carried the 2026-05-18 raw
 * backfill's *local-only* (never-uploaded) value, the per-row recheck below
 * skipped every row — a clean, write-nothing run — yet still recorded the
 * marker. A later server-authoritative pass then dropped those never-synced
 * local values, leaving ~4k daily notes with `daily-note:date` genuinely NULL
 * on both local and server, and the marker permanently blocking a re-run. The
 * rows are NULL now, so a fresh run's recheck passes and it actually writes +
 * uploads — but a re-run is only possible by changing the marker key. Bumping
 * the `id` (the documented `WorkspaceBackfill.id` escape hatch) forces exactly
 * one re-run per workspace, healing the regressed rows through the uploading
 * path. See scripts/daily-note-date-recovery/README.md.
 */

/** Candidate rows: daily-note-typed, undeleted blocks in this workspace that
 *  carry a valid ISO calendar-day alias but lack `daily-note:date`. The
 *  `date(value) = value` guard rejects shape-only matches (2026-13-01,
 *  2026-02-30, …) that the GLOB lets through; the `block_types` join keeps a
 *  user page merely *aliased* with a date string out of the daily-note
 *  namespace. One row per block (`MIN` over the — at most one — matching
 *  alias). */
const SELECT_LEGACY_DAILY_NOTES_MISSING_DATE_SQL = `
  SELECT b.id AS id, MIN(je.value) AS iso
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${DAILY_NOTE_TYPE}'
  JOIN json_each(b.properties_json, '$.alias') je
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(je.value) = je.value
    AND json_extract(b.properties_json, '$."${dailyNoteDateProp.name}"') IS NULL
  GROUP BY b.id
`

/** Tx batch size. The motivating graph had ~4k legacy notes; one giant tx
 *  would hold the SQLite connection through the whole write (this is deferred
 *  off the open path, but still). Batching also means partial progress
 *  survives a mid-run failure — the marker is only recorded once every batch
 *  commits, so a retry re-scans, and the per-row recheck makes that cheap. */
const BATCH_SIZE = 500

export const dailyNoteDateBackfill: WorkspaceBackfill = {
  // v2: bumped 2026-06-16 to re-run once per workspace and heal the ~4k daily
  // notes whose `daily-note:date` was dropped by a 2026-06-14 server pass after
  // the v1 run had already recorded its one-shot marker (see docstring).
  id: 'daily-note-date-from-alias-v2',
  run: async ({workspaceId, getAll, tx}) => {
    const rows = await getAll<{id: string; iso: string}>(
      SELECT_LEGACY_DAILY_NOTES_MISSING_DATE_SQL,
      [workspaceId],
    )
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      await tx(
        async t => {
          for (const {id, iso} of batch) {
            const block = await t.get(id)
            if (!block || block.deleted) continue
            // Re-check inside the tx: a concurrent getOrCreateDailyNote (or a
            // freshly synced server row) may have set the property between the
            // SELECT and now. Skip those — keeps the write idempotent and
            // avoids a no-op upload.
            if (block.properties[dailyNoteDateProp.name] !== undefined) continue
            await t.setProperty(id, dailyNoteDateProp, dailyNoteDateValue(iso))
          }
        },
        {scope: ChangeScope.BlockDefault, description: 'backfill daily-note:date from ISO alias'},
      )
    }
  },
}
