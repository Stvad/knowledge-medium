// One-time recovery: re-derive `daily-note:date` from the ISO alias for
// daily-note-typed rows where it is NULL, written through `repo.tx`
// (source='user') so the rows upload and the whole fleet converges.
//
// This mirrors src/plugins/daily-notes/backfill.ts EXACTLY (same candidate
// SELECT, same per-row recheck, same setProperty), so running it is equivalent
// to the in-app v2 backfill — it just doesn't require shipping a new app build.
// Idempotent: a row that already has the property (or got it from a concurrent
// run / fresh server sync) is skipped, so re-running after a partial pass is
// safe.
//
// Run via the agent bridge (the target tab must be focused/connected):
//   DRY-RUN (default — reports the candidate count, writes nothing):
//     pnpm agent --profile ff-vlad-dev eval --file scripts/daily-note-date-recovery/recover.eval.js
//   APPLY (performs the writes — HELD until explicitly approved):
//     pnpm agent --profile ff-vlad-dev eval --file scripts/daily-note-date-recovery/recover.eval.js \
//       --data-json '{"apply":true}'
//   Scope to a specific workspace (defaults to the active one):
//     ... --data-json '{"apply":true,"workspaceId":"ef43b424-80ba-4967-b587-a4c32efd8071"}'

const {ChangeScope} = await import('@/data/api')
const {dailyNoteDateValue} = await import('@/plugins/daily-notes/dailyNotes.js')
const {DAILY_NOTE_TYPE, dailyNoteDateProp} = await import('@/plugins/daily-notes/schema.js')

const apply = data?.apply === true
const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId
if (!workspaceId) {
  throw new Error('no workspaceId: no active workspace and none passed via --data-json {"workspaceId":"…"}')
}

// Identical to SELECT_LEGACY_DAILY_NOTES_MISSING_DATE_SQL in backfill.ts.
const SELECT = `
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

const rows = await sql(SELECT, [workspaceId], 'all')

if (!apply) {
  return {
    mode: 'dry-run',
    workspaceId,
    candidates: rows.length,
    sample: rows.slice(0, 5),
    note: 'no writes performed; pass --data-json \'{"apply":true}\' to recover',
  }
}

const BATCH = 500
let written = 0
let skipped = 0
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  await repo.tx(
    async t => {
      for (const {id, iso} of batch) {
        const block = await t.get(id)
        if (!block || block.deleted) { skipped += 1; continue }
        // Re-check inside the tx: a concurrent creation-path write or a freshly
        // synced server row may have set it between SELECT and now.
        if (block.properties[dailyNoteDateProp.name] !== undefined) { skipped += 1; continue }
        await t.setProperty(id, dailyNoteDateProp, dailyNoteDateValue(iso))
        written += 1
      }
    },
    {scope: ChangeScope.BlockDefault, description: 'recover daily-note:date from ISO alias'},
  )
}

return {mode: 'apply', workspaceId, candidates: rows.length, written, skipped}
