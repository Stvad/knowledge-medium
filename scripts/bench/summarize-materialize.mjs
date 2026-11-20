/**
 * Prints one row per measured sample from either runner's output.
 *   node scripts/bench/summarize-materialize.mjs <node-output.jsonl | browser.json>
 * "upsert" is the summed time of the `INSERT INTO blocks (` statements.
 */
import {readFileSync} from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const rows = []
const upsertMs = statements =>
  statements.filter(s => s.sql.startsWith('INSERT INTO blocks (')).reduce((n, s) => n + s.elapsedMs, 0)
const summarize = (r, extra) => ({
  scenario: r.scenario, mode: r.mode, wallMs: Math.round(r.wallMs), txMs: Math.round(r.txMs),
  phase1Ms: Math.round(r.phase1Ms), rowsPerS: Math.round(r.records / (r.wallMs / 1000)),
  upsertMs: Math.round(upsertMs(r.statements)),
  ...(extra.cache ? {pages: extra.cache.pageCount, cache: extra.cache.cacheSize, cachedFraction: extra.cache.cachedFraction} : {}),
  ...(extra.rebuildMs ? {rebuildMs: Object.fromEntries(extra.rebuildMs.map(x => [x.label, x.ms]))} : {}),
  ...(extra.recreateIndexMs ? {recreateIndexMs: Object.fromEntries(extra.recreateIndexMs.map(x => [x.name, x.ms]))} : {}),
})
try {
  const report = JSON.parse(text)
  for (const s of report.samples) {
    rows.push(summarize({
      scenario: s.scenario, mode: s.mode, wallMs: s.wallMs, txMs: s.metrics.txElapsedMs,
      phase1Ms: s.metrics.phase1ElapsedMs, records: report.count,
      statements: s.metrics.sql.map(([sql, m]) => ({sql, elapsedMs: m.elapsedMs})),
    }, s.extra ?? {}))
  }
} catch {
  for (const line of text.split('\n').filter(l => l.startsWith('{"scenario"'))) {
    const d = JSON.parse(line)
    const {scenario, mode, wallMs, writeTransactionMs, phase1Ms, records, statements, ...rest} = d
    rows.push(summarize({scenario, mode, wallMs, txMs: writeTransactionMs, phase1Ms, records, statements}, rest))
  }
}
for (const r of rows) console.log(JSON.stringify(r))
