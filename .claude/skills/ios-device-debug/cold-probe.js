(async () => {
  const t = await import('@/utils/startupTimeline.js')
  const nav = performance.getEntriesByType('navigation')[0]
  const res = performance.getEntriesByType('resource')
  const r = v => Math.round(v)
  const byType = {}
  for (const e of res) {
    const ext = (e.name.split('?')[0].split('.').pop() || '').slice(0, 5)
    const k = ext + (e.transferSize === 0 ? ':cache' : ':net')
    byType[k] ??= {n: 0, bytes: 0, dur: 0, maxEnd: 0, minStart: 1e9}
    const b = byType[k]; b.n++; b.bytes += e.decodedBodySize || 0; b.dur += e.duration; b.maxEnd = Math.max(b.maxEnd, e.responseEnd); b.minStart = Math.min(b.minStart, e.startTime)
  }
  for (const b of Object.values(byType)) { b.bytes = r(b.bytes / 1024) + 'KB'; b.dur = r(b.dur); b.maxEnd = r(b.maxEnd); b.minStart = r(b.minStart) }
  const marks = {}; for (const [k, v] of Object.entries(t.getStartupTimeline().marks)) marks[k] = r(v)
  const first = res.slice().sort((a, b) => a.startTime - b.startTime).slice(0, 5).map(e => [r(e.startTime), r(e.responseEnd), e.name.split('/').pop().slice(0, 40)])
  const last = res.slice().sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 5).map(e => [r(e.startTime), r(e.responseEnd), e.name.split('/').pop().slice(0, 40)])
  // DB init end, after the fact: the forensics session record is written right
  // after ensurePowerSyncReady's init (src/utils/dbForensics.ts), as epoch ms.
  const dbInitEndMs = await new Promise(resolve => {
    try {
      const req = indexedDB.open('km-db-forensics')
      req.onerror = () => resolve(null)
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction('forensics', 'readonly')
          const g = tx.objectStore('forensics').get('session:current')
          g.onsuccess = () => resolve(g.result ? r(g.result.startedAt - performance.timeOrigin) : null)
          g.onerror = () => resolve(null)
        } catch { resolve(null) }
      }
    } catch { resolve(null) }
  })
  // Service-worker boot marks (builds with the BOOT_MARKS reply in sw.ts):
  // the SW's own timeOrigin placed on the page's clock, when its script
  // finished evaluating, and when the first navigation was received/answered.
  const swMarks = await new Promise(resolve => {
    try {
      const c = navigator.serviceWorker?.controller
      if (!c) return resolve(null)
      const ch = new MessageChannel()
      const t = setTimeout(() => resolve('no reply (SW without BOOT_MARKS?)'), 3000)
      ch.port1.onmessage = ev => {
        clearTimeout(t)
        const m = ev.data
        const off = m.timeOrigin - performance.timeOrigin
        resolve({swStartedAt: r(off), swEvaluatedAt: r(off + m.evaluatedAt), firstNavReceivedAt: r(off + m.firstNavAt), firstNavAnsweredAt: r(off + m.firstNavRespondedAt), raw: m})
      }
      c.postMessage('BOOT_MARKS', [ch.port2])
    } catch (e) { resolve(String(e)) }
  })
  const cacheNames = await caches.keys()
  const cacheCounts = {}; for (const n of cacheNames) cacheCounts[n] = (await (await caches.open(n)).keys()).length
  return {
    marks, dbInitEndMs, swMarks,
    nav: nav && {type: nav.type, fetchStart: r(nav.fetchStart), responseEnd: r(nav.responseEnd), domInteractive: r(nav.domInteractive), domContentLoaded: r(nav.domContentLoadedEventEnd), loadEnd: r(nav.loadEventEnd), transfer: nav.transferSize, workerStart: r(nav.workerStart)},
    swControlled: !!navigator.serviceWorker?.controller, resources: res.length, byType, first, last, cacheCounts,
  }
})()
