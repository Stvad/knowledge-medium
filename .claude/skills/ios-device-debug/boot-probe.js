// Boot-phase probe for a live KM tab. Runs as one async expression, so it works
// both through `MATCH=github node ios.mjs eval "$(rg -v "^//" boot-probe.js)"`
// (real iPhone/iPad over iwdp, no bridge needed) and through
// `pnpm agent eval --profile <p> "return $(rg -v "^//" boot-probe.js)"` (Mac baseline).
// Read-only: SELECTs and EXPLAIN only.
(async () => {
  const p = await import('@/data/repoProvider.js')
  const t = await import('@/utils/startupTimeline.js')
  const tq = await import('@/data/internals/treeQueries.js')
  const db = p.getPowerSyncDb(p.getActiveUserId())
  const out = { marks: t.getStartupTimeline().marks, ua: navigator.userAgent, standalone: navigator.standalone ?? null }
  const step = async (label, fn) => {
    const s = performance.now()
    try { out[label] = { ms: Math.round((performance.now() - s) * 10) / 10, value: await fn() }; out[label].ms = Math.round(performance.now() - s) }
    catch (e) { out[label] = { error: String(e) } }
  }
  await step('storage', () => navigator.storage?.estimate?.())
  await step('ping', () => db.getAll('select 1'))
  await step('counts', () => db.getAll(`select (select count(*) from blocks) as blocks, (select count(*) from blocks where deleted = 0) as live, (select count(*) from row_events) as row_events, (select count(*) from ps_crud) as ps_crud, (select count(*) from block_references) as refs, (select count(*) from block_aliases) as aliases`))
  await step('stat1', () => db.getAll(`select tbl, idx, stat from sqlite_stat1 where tbl in ('blocks','block_references','block_aliases') order by tbl, idx`))
  await step('markers', () => db.getAll(`select key, completed_at from client_schema_state order by completed_at desc`))
  const ui = await db.getAll(`select id, workspace_id from blocks where content = 'ui-state' and deleted = 0 order by user_updated_at desc limit 1`)
  await step('subtreePlan', () => db.getAll(`explain query plan ${tq.SUBTREE_SQL}`, [ui[0]?.id]).then(r => r.map(x => x.detail)))
  await step('subtreeUiState', () => db.getAll(tq.SUBTREE_SQL, [ui[0]?.id]).then(r => r.length))
  await step('childrenOfUiState', () => db.getAll(`select id from blocks indexed by idx_blocks_parent_order where parent_id = ? and deleted = 0`, [ui[0]?.id]).then(r => r.length))
  await step('definitionBlocks', () => db.getAll(`select count(*) as n from block_types where type in ('property-schema','block-type')`))
  await step('pragma', () => db.getAll(`select (select page_count from pragma_page_count) * (select page_size from pragma_page_size) as bytes, (select journal_mode from pragma_journal_mode) as journal`))
  return out
})()
