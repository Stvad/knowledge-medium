// Does PRAGMA optimize actually WRITE sqlite_stat1 under wa-sqlite/OPFS, on the
// connection PowerSync would really use? Both failure modes, each inside a write
// transaction that is rolled back.
//
//   M1 "new index"    -- delete the stat row for idx_block_references_ws_alias,
//                        which is exactly the state CREATE INDEX leaves behind.
//   M2 "stale stats"  -- rewrite blocks' stat rows to the degenerate "0 0" shape
//                        (the legacy bug analyzeIsWarranted force-corrects).
//
// Deliberately NO query is issued against blocks/block_references here: the
// point is to observe whether the PowerSync WRITE connection has these tables
// armed on its own, from the app's normal traffic.
const out = {}
const ROLLBACK = new Error('__rollback__')

const WS_ALIAS = "SELECT stat FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'"
const BLOCKS_WS = "SELECT stat FROM sqlite_stat1 WHERE tbl='blocks' AND idx='idx_blocks_workspace_active'"
const one = async (label, damage, read) => {
  const r = {}
  try {
    await db.writeTransaction(async tx => {
      await tx.execute('PRAGMA analysis_limit=400')
      await tx.execute(damage)
      r.damaged = ((await tx.execute(read)).rows?._array ?? [])[0]?.stat ?? null
      r.dryRun_defaultMask = ((await tx.execute('PRAGMA optimize(0x03)')).rows?._array ?? []).map(x => x.optimize)
      const t = performance.now()
      await tx.execute('PRAGMA optimize')
      r.optimizeMs = Math.round(performance.now() - t)
      r.repaired = ((await tx.execute(read)).rows?._array ?? [])[0]?.stat ?? null
      throw ROLLBACK
    })
  } catch (e) { if (e !== ROLLBACK) r.error = String(e?.message ?? e) }
  r.didRepair = r.repaired !== r.damaged
  return r
}

out.M1_newIndex = await one(
  'new-index',
  "DELETE FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'",
  WS_ALIAS,
)
out.M2_staleStats = await one(
  'stale-stats',
  "UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'",
  BLOCKS_WS,
)

// M2 again, but with the table explicitly armed first -- isolates "the rule did
// not fire" from "the write connection had not planned against blocks".
const r3 = {}
try {
  await db.writeTransaction(async tx => {
    await tx.execute('PRAGMA analysis_limit=400')
    await tx.execute("UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'")
    await tx.execute('SELECT id FROM blocks WHERE workspace_id = ? AND deleted = 0 LIMIT 5', [repo.activeWorkspaceId])
    r3.dryRun_defaultMask = ((await tx.execute('PRAGMA optimize(0x03)')).rows?._array ?? []).map(x => x.optimize)
    const t = performance.now()
    await tx.execute('PRAGMA optimize')
    r3.optimizeMs = Math.round(performance.now() - t)
    r3.repaired = ((await tx.execute(BLOCKS_WS)).rows?._array ?? [])[0]?.stat ?? null
    throw ROLLBACK
  })
} catch (e) { if (e !== ROLLBACK) r3.error = String(e?.message ?? e) }
out.M3_staleStats_armedFirst = r3

out.leftUnchanged = {
  wsAlias: (await db.getAll(WS_ALIAS))[0]?.stat,
  blocksWs: (await db.getAll(BLOCKS_WS))[0]?.stat,
}
return out
