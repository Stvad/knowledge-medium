#!/usr/bin/env node
/**
 * Deep-tier fuzz runner — `yarn fuzz [vitest args…]`.
 *
 * Runs every `*.fuzz.test.ts` suite (or just the files you name) with a
 * per-property time budget and a fresh random seed per property, instead
 * of the fixed-seed smoke sweep the normal test gate does. See
 * src/test/fuzz.ts for the tier mechanics and docs/fuzzing.md for the
 * workflow (reproducing failures, adding suites).
 *
 * Env:
 *   FUZZ_TIME_MS  per-property budget, default 15000
 *   FUZZ_RUNS     fixed run count instead of a time budget
 *   FUZZ_SEED / FUZZ_PATH  reproduce a reported failure
 *
 * Also doubles as the nightly-workflow report builder — see
 * `buildFailureReport` below and its `--report` CLI entry, used by
 * .github/workflows/fuzz-nightly.yml. The parsing/formatting logic lives
 * here (rather than inline shell) so it's testable; the workflow still
 * owns the gh-CLI orchestration (issue lookup/create/comment).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// ---------------------------------------------------------------------
// Nightly failure-report builder
// ---------------------------------------------------------------------

// Vitest's default reporter marks failing files two ways we care about:
//  - the per-file tree row, e.g.
//      ❯ src/data/test/twoRepoConvergence.fuzz.test.ts (12 tests | 1 failed) 3s
//    (✓ rows are fully-passing files and are skipped)
//  - "FAIL" rows in the "Failed Tests" section and for whole-file
//    crashes (setup errors etc.) that never produce a tree row, e.g.
//      FAIL  src/data/test/twoRepoConvergence.fuzz.test.ts > suite > test
// Pull the file path out of either. CI output isn't a TTY so vitest
// disables color, but strip ANSI defensively in case that ever changes.
export function extractFailingFiles(log) {
  const clean = log.replace(/\x1B\[[0-9;]*m/g, '')
  const files = new Set()
  for (const line of clean.split('\n')) {
    const treeRow = line.match(
      /^\s*([✓✗×❯↓])\s+(\S+\.test\.\w+)\s+\(\d+\s+tests?(?:\s*\|\s*(\d+)\s+failed)?\)/,
    )
    if (treeRow) {
      const [, marker, file, failedCount] = treeRow
      if (marker !== '✓' || Number(failedCount ?? 0) > 0) files.add(file)
      continue
    }
    const failRow = line.match(/^\s*FAIL\s+(\S+\.test\.\w+)/)
    if (failRow) files.add(failRow[1])
  }
  return [...files]
}

function tailBytes(str, n) {
  const buf = Buffer.from(str, 'utf8')
  if (buf.length <= n) return str
  return buf.subarray(buf.length - n).toString('utf8')
}

// Best-effort: fast-check's seed/path/shrunk-counterexample block usually
// sits within a few lines of a "seed:" line. Equivalent to the previous
// `grep -B3 -A12 'seed:' | tail -c 5000`, but merges overlapping windows
// (no duplicate lines / grep "--" separators) when "seed:" appears more
// than once. Falls back to a plain tail when there's no match at all
// (e.g. a non-fast-check crash).
export function excerptSeedBlock(log) {
  const lines = log.split('\n')
  const keep = new Set()
  lines.forEach((line, i) => {
    if (line.includes('seed:')) {
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 12); j++) keep.add(j)
    }
  })
  if (keep.size === 0) return tailBytes(log, 5000)
  const text = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n')
  return tailBytes(text, 5000)
}

// fast-check reports its replay parameters as, e.g.
//   { seed: -915705129, path: "20419:0:0:…", endOnFailure: true }
// Pull out the seed and the leading run index (the `path`'s first segment is
// the generation offset of the failure). The report uses these to offer a
// *regenerate-from-seed* command in addition to the path replay — see
// `buildFailureReport`. Returns null when no seed line is present (a
// non-fast-check crash).
export function parseSeedAndPath(log) {
  const seed = log.match(/\bseed:\s*(-?\d+)/)?.[1]
  if (seed === undefined) return null
  const path = log.match(/\bpath:\s*"([^"]*)"/)?.[1]
  const firstSegment = path ? Number(path.split(':')[0]) : NaN
  return { seed, path, runIndex: Number.isInteger(firstSegment) ? firstSegment : undefined }
}

const ISSUE_381_NOTE = `**Known standing red:** the convergence deep tier (\`twoRepoConvergence.fuzz.test.ts\`) is expected to fail nightly while #381 (server-side fix) is open — do not treat that alone as new. Triage:
1. Does the failing-file list above contain anything BESIDES \`twoRepoConvergence.fuzz.test.ts\`? If so, that's new — investigate it.
2. If only convergence failed, compare the seed/path/shrunk counterexample below against #381's. A different fingerprint is a second, distinct bug in the same property, not the known one.`

/**
 * @param {{runUrl: string, sections: {name: string, log: string | null}[]}} args
 *   `sections` should already be filtered to the step(s) that actually
 *   failed — a passing pass after a failing one must not bury the seed
 *   under green output.
 */
export function buildFailureReport({ runUrl, sections }) {
  const allFiles = new Set()
  const blocks = []
  for (const { name, log } of sections) {
    if (log == null) {
      blocks.push(`\n### ${name}\n\n\`(no log captured)\`\n`)
      continue
    }
    for (const f of extractFailingFiles(log)) allFiles.add(f)
    blocks.push(`\n### ${name}\n\n\`\`\`\n${excerptSeedBlock(log)}\n\`\`\`\n`)
  }

  const headline = `Nightly fuzz run failed: ${runUrl} (full logs in the run's fuzz-output artifact).`

  const failingFiles = allFiles.size > 0
    ? `**Failing test files:**\n${[...allFiles].map((f) => `- \`${f}\``).join('\n')}\n`
    : `**Failing test files:** couldn't be determined from the log — check the fuzz-output artifact.\n`

  const excerpt = blocks.length > 0
    ? blocks.join('')
    : '\n(no step reported failure — see the fuzz-output artifact.)\n'

  const onlyFile = allFiles.size === 1 ? [...allFiles][0] : '<failing file>'
  const seedInfo = sections.map((s) => (s.log ? parseSeedAndPath(s.log) : null)).find(Boolean)

  // Two reproduce paths. The FUZZ_PATH replay jumps straight to the shrunk
  // counterexample (fast) and is right for a normal deterministic property.
  // But if the shrink is unsound — a non-deterministic or engine-sensitive
  // property, where the reported counterexample *passes* on replay (see
  // docs/fuzzing.md) — you must regenerate the whole sequence from the seed:
  // drop the path and run enough cases to reach the failure. `runIndex` is the
  // 0-based generation offset from the path, so `FUZZ_RUNS = runIndex + 1`
  // reaches it. (`fuzzParams` short-circuits a path replay regardless of
  // count, which is why the path form can't be made to regenerate.)
  const pathReplay =
    "Reproduce — first try the fast path replay (find the `seed`/`path` in the report above if not filled in):\n" +
    `\`FUZZ_SEED=<seed> FUZZ_PATH="<path>" yarn vitest run --testTimeout=600000 ${onlyFile} -t "<failing test>"\``

  const regen =
    seedInfo?.runIndex !== undefined
      ? '\n\nIf that replay **passes**, the shrink is unsound — regenerate the full sequence from the seed instead:\n' +
        `\`FUZZ_SEED=${seedInfo.seed} FUZZ_RUNS=${seedInfo.runIndex + 1} yarn vitest run --testTimeout=600000 ${onlyFile} -t "<failing test>"\``
      : ''

  const repro = `${pathReplay}${regen}\n\n(see docs/fuzzing.md).`

  return [headline, '', failingFiles, ISSUE_381_NOTE, excerpt, repro].join('\n')
}

// `node scripts/fuzz.mjs --report "<step name>|<log file>" […]` — used by
// the nightly workflow; each arg names a failed step and its captured
// log (missing files are reported as "no log captured", matching a step
// whose log-upload never happened). Prints the issue body to stdout.
function runReportCli(args) {
  const sections = args.map((entry) => {
    const sep = entry.indexOf('|')
    const name = entry.slice(0, sep)
    const logPath = entry.slice(sep + 1)
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : null
    return { name, log }
  })
  process.stdout.write(buildFailureReport({ runUrl: process.env.RUN_URL ?? '(unknown run)', sections }))
}

// ---------------------------------------------------------------------
// Fuzz runner (default entry point)
// ---------------------------------------------------------------------

function runFuzz(argv) {
  const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
  // FUZZ_RUNS without FUZZ_TIME_MS means a fixed-COUNT run — don't inject
  // the default time budget or fuzzParams would silently interrupt the
  // requested count at 15s. Keep both when the caller set both.
  const runsOnly = process.env.FUZZ_RUNS !== undefined && process.env.FUZZ_TIME_MS === undefined
  const timeMs = runsOnly ? undefined : Number(process.env.FUZZ_TIME_MS ?? 15_000)
  // fast-check's time-limit interrupt (`interruptAfterTimeLimit`, backed by
  // `SkipAfterProperty`) uses an ABSOLUTE deadline that also bounds
  // shrinking — a shrink run cannot execute past it (verified against fc
  // 4.9.0's node_modules source). So the property itself never overruns its
  // own budget; the only headroom this test-level timeout needs is for the
  // one in-flight case that keeps running (and writing to shared state)
  // after `interruptAfterTimeLimit` resolves without awaiting it
  // (docs/fuzzing.md §6), plus setup/teardown/reporting. Count-driven runs
  // have no time bound to derive from — match fuzzTestTimeout() (keep the
  // two in sync).
  const testTimeout = timeMs === undefined ? 3_600_000 : timeMs + 300_000

  const files = argv.length > 0 ? argv : ['fuzz.test.']

  const result = spawnSync(
    yarn,
    ['vitest', 'run', '--testTimeout', String(testTimeout), ...files],
    {
      stdio: 'inherit',
      env: { ...process.env, ...(timeMs === undefined ? {} : { FUZZ_TIME_MS: String(timeMs) }) },
    },
  )
  process.exit(result.status ?? 1)
}

// Only act when run directly (`node scripts/fuzz.mjs …`) — importing this
// module (e.g. to reuse the report-building functions) must not spawn
// vitest or touch stdout/exit.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const args = process.argv.slice(2)
  if (args[0] === '--report') {
    runReportCli(args.slice(1))
  } else {
    runFuzz(args)
  }
}
