// Restore soft-deleted blocks (and the deleted ancestors needed to reach them)
// so the references that still point at them resolve again. DRY-RUN BY DEFAULT.
//
// Run via the agent bridge (the target tab must be focused/connected):
//   dry-run (default):  pnpm agent --profile <profile> eval \
//                         --file scripts/dangling-refs/restore-deleted-blocks.eval.js \
//                         --data-json '{"leaves":["<id>","<id>"]}'
//   apply:              ... --data-json '{"apply":true,"leaves":["<id>","<id>"]}'
//
// Pass the leaf ids to restore via `leaves`. A soft-deleted leaf often sits under
// a soft-deleted parent chain beneath a still-live ancestor; restoring only the
// leaf would leave it orphaned under a dead parent. So for each leaf this walks
// up to the FIRST live ancestor and restores every deleted block on the way
// (leaf + its deleted ancestors). `tx.restore(id)` with no patch preserves the
// block's existing content / properties / references and flips deleted→0; the
// trigger re-derives block_references, so incoming refs resolve again.
//
// Restores ONE block per tx on purpose: restoring several reference-bearing
// blocks in a single tx can hang the live client (the post-restore reprojection
// cascade may not settle within the bridge response timeout). Idempotent:
// already-live blocks are skipped, so a partial run is safe to resume.

const {ChangeScope} = await import('@/data/api')

const apply = data?.apply === true
const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId
const LEAVES = Array.isArray(data?.leaves) ? data.leaves : []
if (LEAVES.length === 0) throw new Error('pass leaf ids to restore via --data-json \'{"leaves":["…"]}\'')

// Walk leaf → up, collecting DELETED blocks until the first live ancestor.
const collectChain = async (leafId) => {
  const deleted = []
  let id = leafId
  for (let guard = 0; id && guard < 50; guard += 1) {
    const b = await sql(`SELECT id, parent_id, deleted FROM blocks WHERE id = ?`, [id], 'optional')
    if (!b) return {leafId, ok: false, reason: `chain hit missing block ${id}`, deleted}
    if (b.deleted === 0) return {leafId, ok: true, liveAncestor: b.id, deleted} // reached live ground
    deleted.push({id: b.id})
    id = b.parent_id
  }
  return {leafId, ok: false, reason: 'no live ancestor within depth', deleted}
}

const chains = []
for (const leaf of LEAVES) chains.push(await collectChain(leaf))

// Restore set = union of all deleted blocks across chains (dedup), restored
// top-down (ancestors before leaves) so the tree is consistent at every step.
const seen = new Set()
const restoreSet = []
for (const c of chains) {
  for (const b of [...c.deleted].reverse()) {
    if (seen.has(b.id)) continue
    seen.add(b.id)
    restoreSet.push(b)
  }
}

const summary = {
  mode: apply ? 'APPLY' : 'DRY-RUN',
  workspaceId,
  chains: chains.map((c) => ({leaf: c.leafId, ok: c.ok, reason: c.reason, liveAncestor: c.liveAncestor, willRestore: c.deleted.map((b) => b.id)})),
  restoreCount: restoreSet.length,
}

if (chains.some((c) => !c.ok)) return {...summary, error: 'a chain has no clean path to a live ancestor — aborting, no writes'}
if (!apply) return {...summary, note: 'DRY-RUN — no writes. Re-run with apply:true to apply.'}

// ── Apply: restore each block in its OWN tx (see header note) ──────────────
const result = {restored: 0, skippedLive: 0, errors: []}
for (const b of restoreSet) {
  const cur = await sql(`SELECT deleted FROM blocks WHERE id = ?`, [b.id], 'optional')
  if (!cur) {
    result.errors.push({id: b.id, why: 'missing at write time'})
    continue
  }
  if (cur.deleted === 0) {
    result.skippedLive += 1
    continue
  }
  try {
    await repo.tx(async (tx) => tx.restore(b.id), {
      // no patch: preserve the block's existing content/properties/references
      scope: ChangeScope.BlockDefault,
      description: 'restore soft-deleted block / ancestor',
    })
    result.restored += 1
  } catch (err) {
    result.errors.push({id: b.id, why: String(err?.message ?? err)})
  }
}

// ── Verify (single snapshot — no long poll, to stay under the bridge timeout) ──
const verifyChains = []
for (const leaf of LEAVES) verifyChains.push(await collectChain(leaf))
const crud = (await sql(`SELECT count(*) n FROM ps_crud`, [], 'get')).n

return {
  ...summary,
  applyResult: result,
  verify: {
    leavesReachable: verifyChains.map((c) => ({leaf: c.leafId, allLiveToAncestor: c.ok && c.deleted.length === 0, liveAncestor: c.liveAncestor})),
    pendingUploadQueue: crud,
  },
}
