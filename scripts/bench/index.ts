/**
 * Bench runner. Invoked via:
 *
 *   yarn bench                  # run all suites at default scale
 *   yarn bench writes reads     # run a subset
 *   yarn bench -- --scale full  # include the large fixture variants
 *                                 (50k+ blocks, deep chains)
 *   yarn bench -- --out path.json   # write JSON results to path
 *
 * Suites:
 *   writes, reads, handles, search, tail, scale
 *
 * Output:
 *   - markdown table per suite to stdout,
 *   - JSON results to tmp/bench-results/<timestamp>.json (or --out).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatTable, type BenchResult } from './harness'
import { runWriteBenches } from './bench-writes'
import { runReadBenches } from './bench-reads'
import { runHandleBenches } from './bench-handles'
import { runSearchBenches } from './bench-search'
import { runTailBenches } from './bench-tail'
import { runScaleBenches } from './bench-scale'

interface SuiteSpec {
  name: string
  run: (opts: {full?: boolean}) => Promise<BenchResult[]>
}

const SUITES: SuiteSpec[] = [
  {name: 'writes', run: () => runWriteBenches()},
  {name: 'reads', run: () => runReadBenches()},
  {name: 'handles', run: () => runHandleBenches()},
  {name: 'search', run: () => runSearchBenches()},
  {name: 'tail', run: () => runTailBenches()},
  {name: 'scale', run: (opts) => runScaleBenches(opts)},
]

const parseArgs = (argv: readonly string[]): {suites: SuiteSpec[]; full: boolean; out: string | null} => {
  let full = false
  let out: string | null = null
  const wanted: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scale' && argv[i + 1] === 'full') { full = true; i++; continue }
    if (a === '--full') { full = true; continue }
    if (a === '--out') { out = argv[++i]; continue }
    if (a === '--' || a.startsWith('--')) continue
    wanted.push(a)
  }
  const suites = wanted.length === 0 ? SUITES : SUITES.filter(s => wanted.includes(s.name))
  if (wanted.length > 0 && suites.length === 0) {
    throw new Error(`No suites matched [${wanted.join(', ')}]. Available: ${SUITES.map(s => s.name).join(', ')}`)
  }
  return {suites, full, out}
}

const main = async (): Promise<void> => {
  const {suites, full, out: outOverride} = parseArgs(process.argv.slice(2))

  console.log(`# Data-layer bench`)
  console.log(`Date: ${new Date().toISOString()}`)
  console.log(`Node: ${process.version}, platform: ${process.platform}, arch: ${process.arch}`)
  console.log(`Scale: ${full ? 'full' : 'default'}`)
  console.log(`Suites: ${suites.map(s => s.name).join(', ')}`)
  console.log()

  const allResults: Record<string, BenchResult[]> = {}
  for (const s of suites) {
    const tStart = Date.now()
    console.log(`## ${s.name}`)
    const results = await s.run({full})
    allResults[s.name] = results
    console.log(formatTable(results))
    console.log(`\n_(${s.name}: ${(Date.now() - tStart) / 1000}s, ${results.length} measurements)_\n`)
  }

  // JSON output for programmatic compare.
  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = outOverride ?? join(
    resolve(here, '../..'),
    'tmp',
    'bench-results',
    `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  mkdirSync(dirname(outPath), {recursive: true})
  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    scale: full ? 'full' : 'default',
    results: allResults,
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`\nResults written to ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
