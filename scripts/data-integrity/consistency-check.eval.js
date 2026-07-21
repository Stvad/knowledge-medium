// Read-only data-integrity consistency check (L3 + L4 of docs/data-integrity-defense.html).
//
// THIN WRAPPER — it reimplements NO checks. It invokes the shared engine
// (@/plugins/data-integrity/audit.js) in `full` mode, which runs the lean
// cadence checks PLUS the deep on-demand inspections:
//   - references_index_mirror     references_json <-> block_references mirror
//   - property_ref_at_rest        schema-aware value-present/ref-absent heuristic
//   - property_ref_projection     PRECISE projection diff (active workspace only)
//   - content_link_recompute      parser-precise content-ref strip / stale recompute
//   - dangling_refs               target missing/deleted (info)
//   - local_server_divergence     blocks <-> blocks_synced (+ bounded e2ee spot-check)
//   - materialized_still_ciphertext  local row still holding enc:v1: (decrypt-verified)
//   - e2ee_content_divergence     EXHAUSTIVE decrypt-compare of equal-stamp e2ee rows
// The always-on data-integrity plugin runs the SAME engine in lean mode — no
// check logic is duplicated between this bridge script and the engine.
//
// Run via the agent bridge (target tab must be focused/connected):
//   pnpm agent --profile <name> eval --file scripts/data-integrity/consistency-check.eval.js
//   ... --data-json '{"workspaceId":"…"}'                # one workspace (default: active)
//   ... --data-json '{"allWorkspaces":true}'             # every workspace on the client
//   ... --data-json '{"sampleLimit":20,"candidateCap":80000,"contentCap":2000000}'
//
// Output: `report.workspaces[<id>]` holds each workspace's full ConsistencyAuditResult;
// for a single workspace, `report.checks` also mirrors it at the top level (back-compat).

const allWorkspaces = data?.allWorkspaces === true
const workspaceId = data?.workspaceId ?? (allWorkspaces ? null : repo.activeWorkspaceId)
const sampleLimit = Number.isInteger(data?.sampleLimit) ? data.sampleLimit : 10
const candidateCap = Number.isInteger(data?.candidateCap) ? data.candidateCap : 60000
const contentCap = Number.isInteger(data?.contentCap) ? data.contentCap : 1_000_000
const decryptCap = Number.isInteger(data?.decryptCap) ? data.decryptCap : 200_000

if (!allWorkspaces && !workspaceId) {
  throw new Error(
    'no workspaceId: no active workspace and none passed. Use --data-json {"workspaceId":"…"} or {"allWorkspaces":true}',
  )
}

const { runConsistencyAudit } = await import('@/plugins/data-integrity/audit.js')
const { syncObserverDepsFor } = await import('@/data/repoProvider.js')

// The engine's AuditDb is just `{ getAll }`; back it with the bridge's `sql`.
const auditDb = { getAll: (text, params = []) => sql(text, params, 'all') }
// The §6 mode/key resolver (real in the live tab) — powers the e2ee decrypt checks.
const decrypt = syncObserverDepsFor(repo.user.id)

const workspaceIds = allWorkspaces
  ? (
      // Union across all three tables: a workspace can have surviving
      // block_references / blocks_synced rows with no live `blocks` (all hard-
      // deleted) — enumerating from `blocks` alone would skip its orphan/mirror
      // checks entirely.
      await auditDb.getAll(
        `SELECT workspace_id AS id FROM blocks WHERE workspace_id IS NOT NULL
         UNION SELECT workspace_id FROM block_references WHERE workspace_id IS NOT NULL
         UNION SELECT workspace_id FROM blocks_synced WHERE workspace_id IS NOT NULL
         ORDER BY id`,
      )
    ).map((r) => r.id)
  : [workspaceId]

const report = {
  mode: 'read-only',
  generatedAt: new Date().toISOString(),
  scope: allWorkspaces ? 'all-workspaces' : workspaceId,
  sampleLimit,
  workspaces: {},
  anomalies: 0,
}

for (const ws of workspaceIds) {
  const result = await runConsistencyAudit(auditDb, ws, Date.now(), {
    // Debounce a transient mid-sync divergence pass (report the settled counts).
    divergenceRecheckMs: 4000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    decrypt,
    full: {
      // Precise projection is sound only for the ACTIVE workspace (repo.propertySchemas
      // is active-only); the engine skips it for any other ws.
      schemas: repo.propertySchemas,
      activeWorkspaceId: repo.activeWorkspaceId,
      candidateCap,
      contentCap,
      decryptCap,
      sampleLimit,
    },
  })
  report.workspaces[ws] = result
  report.anomalies += result.anomalies
}

// Single-workspace convenience: also surface the one result's checks at the top
// level, preserving the historical flat `report.checks` shape.
if (!allWorkspaces && workspaceIds.length === 1) {
  report.checks = report.workspaces[workspaceIds[0]]?.checks ?? {}
}

return report
