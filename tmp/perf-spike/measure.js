/* Per-trial measurement. Returns a structured snapshot of:
 *   - whether virtualization is active
 *   - block-mount counters (cumulative since pageload)
 *   - scroll-container size + visible block count
 *   - paint timings
 *   - scroll-FPS over a 1.5s programmatic scroll
 *
 * Pasted into preview_eval after the page has had ~5s to stabilize.
 */
(async () => {
  const stats = /** @type {any} */ (window).__blockStats ?? {mounts: 0, live: 0, unmounts: 0}
  const tree = document.querySelector('.virtualized-block-tree')
  const isVirt = !!tree
  const scrollEl = tree ?? document.scrollingElement
  const visibleBlocks = document.querySelectorAll('.tm-block').length

  // Paint timings — the browser keeps these.
  const paints = performance.getEntriesByType('paint').map(p => ({
    name: p.name,
    startTime: Math.round(p.startTime),
  }))
  const nav = performance.getEntriesByType('navigation')[0]
  const loadTime = nav ? Math.round(nav.loadEventEnd) : null

  // Scroll FPS test: animate scroll over 1500ms, count rAF callbacks.
  const beforeScrollMounts = stats.mounts
  const beforeScrollLive = stats.live
  const scrollHeight = scrollEl?.scrollHeight ?? 0
  const clientHeight = scrollEl?.clientHeight ?? 0
  const scrollDistance = Math.max(0, scrollHeight - clientHeight)

  let scrollResult = null
  if (scrollDistance > 0 && scrollEl) {
    scrollResult = await new Promise((resolve) => {
      const duration = 1500
      const start = performance.now()
      let frames = 0
      let lastFrame = start
      let maxFrameMs = 0
      const tick = (now) => {
        frames++
        const dt = now - lastFrame
        if (dt > maxFrameMs) maxFrameMs = dt
        lastFrame = now
        const elapsed = now - start
        const t = Math.min(1, elapsed / duration)
        scrollEl.scrollTo(0, t * scrollDistance)
        if (elapsed < duration) requestAnimationFrame(tick)
        else {
          // Give one more rAF for final mounts to settle.
          requestAnimationFrame(() => {
            const elapsedMs = Math.round(performance.now() - start)
            resolve({
              elapsedMs,
              frames,
              fps: Math.round(frames / (elapsedMs / 1000)),
              maxFrameMs: Math.round(maxFrameMs),
            })
          })
        }
      }
      requestAnimationFrame(tick)
    })
  }

  const afterScrollStats = /** @type {any} */ (window).__blockStats ?? stats
  const visibleAfterScroll = document.querySelectorAll('.tm-block').length

  return {
    mode: isVirt ? 'virtualized' : 'tree',
    paints,
    loadEventEndMs: loadTime,
    initial: {
      mounts: beforeScrollMounts,
      live: beforeScrollLive,
      visibleBlocks,
    },
    scroll: scrollResult ?? {skipped: 'no scroll distance'},
    final: {
      mounts: afterScrollStats.mounts,
      live: afterScrollStats.live,
      mountsDuringScroll: afterScrollStats.mounts - beforeScrollMounts,
      visibleBlocks: visibleAfterScroll,
    },
    container: {
      scrollHeight,
      clientHeight,
      scrollDistance,
    },
  }
})()
