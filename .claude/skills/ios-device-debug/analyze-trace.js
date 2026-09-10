const o = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
const lo = Number(process.argv[3] ?? o.marks.workspaceResolved), hi = Number(process.argv[4] ?? o.marks.bootstrapDone)
const verbose = process.argv[5] === "v"
const outs = new Map(); const calls = []
for (const e of o.trace) {
  if (e.d === 'out') outs.set(e.w + e.id, e)
  else if (e.d === 'in') { const s = outs.get(e.w + e.id); if (s) { calls.push({start: s.t, end: e.t, w: s.w, p: s.p, a: s.a, ty: e.ty}); outs.delete(e.w + e.id) } }
}
const sql = a => { try { const arr = JSON.parse(a.endsWith(']') ? a : a + '"}]'); const v = arr[0]?.value; return typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 110) : JSON.stringify(v).slice(0, 80) } catch { return a.slice(0, 110) } }
const win = calls.filter(c => c.start >= lo && c.start <= hi).sort((x, y) => x.start - y.start)
console.log(`window ${lo}..${hi} (${hi - lo}ms): ${win.length} calls`)
// idle gaps: time with no call in flight
let cursor = lo, idle = 0
const busy = win.map(c => [c.start, c.end]).sort((a, b) => a[0] - b[0])
let curEnd = lo
for (const [s, e] of busy) { if (s > curEnd) idle += s - curEnd; curEnd = Math.max(curEnd, e) }
if (hi > curEnd) idle += hi - curEnd
console.log(`idle (nothing in flight): ${Math.round(idle)}ms`)
const byP = {}
for (const c of win) { const k = c.w + ' ' + c.p; byP[k] ??= {n: 0, ms: 0}; byP[k].n++; byP[k].ms += c.end - c.start }
console.log('by path:', Object.entries(byP).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} n=${v.n} ${Math.round(v.ms)}ms`).join(' | '))
const slow = [...win].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 12)
console.log('slowest:'); for (const c of slow) console.log(`  ${Math.round(c.start)}..${Math.round(c.end)} +${Math.round(c.end - c.start)}ms ${c.w} ${c.p} ${sql(c.a)}`)
if (verbose) { console.log('all:'); for (const c of win) console.log(`  ${Math.round(c.start)} +${Math.round(c.end - c.start)} ${c.w} ${c.p} ${sql(c.a)}`) }
// unpaired outs in window
const un = [...outs.values()].filter(e => e.t >= lo && e.t <= hi); if (un.length) console.log('unanswered in window:', un.map(e => `${Math.round(e.t)} ${e.w} ${e.p} ${sql(e.a)}`).join('\n  '))
