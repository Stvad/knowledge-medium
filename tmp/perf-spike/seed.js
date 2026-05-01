/* Synthetic-data seeder for the virtualization spike.
 *
 * Run as a single async IIFE inside the running app (preview_eval).
 * Reads `window.__app.repo`, creates a deep tree under a fresh container
 * block, stamps it as a top-level navigation target, and reports the
 * container id (so subsequent runs can navigate to it without re-seeding).
 *
 * Tree shape: balanced N-ary tree, configurable depth + branching.
 * Default: depth=4, branching=8 → 1 + 8 + 64 + 512 + 4096 = 4681 blocks.
 * Pass overrides via `window.__seedConfig` before invoking.
 */
(async () => {
  const app = /** @type {any} */ (window).__app
  if (!app?.repo) { return {error: 'no app/repo on window — wait for app to load'} }
  const repo = app.repo
  const cfg = Object.assign(
    {depth: 4, branching: 8, label: 'perf-spike'},
    /** @type {any} */ (window).__seedConfig ?? {},
  )

  // Reuse if already seeded with same config — keyed by label + shape.
  const cacheKey = `__perfSpike:${cfg.label}:${cfg.depth}:${cfg.branching}`
  const existingId = localStorage.getItem(cacheKey)
  if (existingId) {
    // Verify the row still exists; if not, fall through and re-create.
    try {
      const existing = await repo.load(existingId)
      if (existing && !existing.deleted) {
        return {reused: true, rootId: existingId, config: cfg}
      }
    } catch { /* stale id — re-seed */ }
  }

  const t0 = performance.now()

  // Container block: child of the landing block, content names the trial.
  const containerContent = `[perf-spike depth=${cfg.depth} branching=${cfg.branching}]`
  const containerId = await repo.mutate.createChild({
    parentId: app.landingBlockId,
    content: containerContent,
    position: {kind: 'last'},
  })

  // Build BFS — track frontier nodes per depth level.
  let frontier = [containerId]
  let totalCreated = 1
  for (let d = 1; d <= cfg.depth; d++) {
    const nextFrontier = []
    for (const parentId of frontier) {
      // Insert N children per parent in one tx for speed.
      const ids = await repo.mutate.insertChildren({
        parentId,
        items: Array.from({length: cfg.branching}, (_, i) => ({
          content: `lvl${d}-${i.toString(36)} — synthetic block ${totalCreated + i + 1}`,
        })),
      })
      for (const id of ids) nextFrontier.push(id)
      totalCreated += ids.length
    }
    frontier = nextFrontier
  }
  const t1 = performance.now()

  localStorage.setItem(cacheKey, containerId)
  return {
    seeded: true,
    rootId: containerId,
    totalBlocks: totalCreated,
    seedTimeMs: Math.round(t1 - t0),
    config: cfg,
  }
})()
