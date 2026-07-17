import {afterAll, describe, expect, it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// Black-box test of `node scripts/fuzz.mjs --report …` (the entry the nightly
// workflow invokes to build the failure-issue body). Driving the real CLI
// avoids importing the untyped `.mjs` into the tsc-checked scripts project.
const fuzzScript = fileURLToPath(new URL('./fuzz.mjs', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'fuzz-report-'))
afterAll(() => rmSync(tmp, {recursive: true, force: true}))

const runReport = (stepName: string, log: string): string => {
  const logPath = join(tmp, `${stepName.replace(/\W+/g, '_')}.log`)
  writeFileSync(logPath, log)
  return execFileSync('node', [fuzzScript, '--report', `${stepName}|${logPath}`], {
    encoding: 'utf8',
    env: {...process.env, RUN_URL: 'https://example.test/run/1'},
  })
}

// The nightly passes one `name|logfile` arg per FAILED step; the report picks
// the seed/path across all of them.
const runReportSections = (sections: {name: string; log: string}[]): string => {
  const args = sections.map(({name, log}, i) => {
    const logPath = join(tmp, `multi-${i}-${name.replace(/\W+/g, '_')}.log`)
    writeFileSync(logPath, log)
    return `${name}|${logPath}`
  })
  return execFileSync('node', [fuzzScript, '--report', ...args], {
    encoding: 'utf8',
    env: {...process.env, RUN_URL: 'https://example.test/run/1'},
  })
}

// A trimmed but realistic fast-check failure log: a `FAIL` row (so the failing
// file is extracted) plus fast-check's seed/path replay-parameters line.
const failingLog = [
  ' FAIL  src/data/api/blockData.fuzz.test.ts > parseBlockRow / blockToRowParams (blockSchema.ts) > blockToRowParams -> parseBlockRow round-trips an arbitrary BlockData',
  'Error: Property failed after 20420 tests',
  '{ seed: -915705129, path: "20419:0:0:0:5:5:5", endOnFailure: true }',
  'Counterexample: [{"id":" ","properties":{"\\"":{}}}]',
  'Shrunk 33 time(s)',
].join('\n')

describe('fuzz --report', () => {
  it('emits a regenerate-from-seed command with FUZZ_RUNS = runIndex + 1', () => {
    const body = runReport('Deep fuzz — all suites', failingLog)

    // Failing file is listed and threaded into the reproduce commands.
    expect(body).toContain('- `src/data/api/blockData.fuzz.test.ts`')
    // Path replay is still offered.
    expect(body).toContain('FUZZ_PATH="<path>"')
    // Regenerate command: seed carried through, FUZZ_RUNS = 20419 + 1.
    expect(body).toContain('FUZZ_SEED=-915705129 FUZZ_RUNS=20420 yarn vitest run')
    // And it names the concrete failing file, not the placeholder.
    expect(body).toMatch(/FUZZ_RUNS=20420 yarn vitest run --testTimeout=600000 src\/data\/api\/blockData\.fuzz\.test\.ts/)
    // The unsound-shrink rationale is present so the reader knows WHY.
    expect(body).toContain('If that replay **passes**')
  })

  it('pairs seed and path from the SAME block when a step has multiple failures', () => {
    // An earlier property interrupts (seed only, no path); a later property has
    // a real path. The regenerate command must use the block that carries the
    // path, not splice the first seed onto the second path.
    const multiFailLog = [
      ' FAIL  src/data/api/blockData.fuzz.test.ts > suite > property A',
      'Error: Property interrupted after 0 tests',
      '{ seed: 111, endOnFailure: true }',
      ' FAIL  src/data/api/blockData.fuzz.test.ts > suite > property B',
      'Error: Property failed after 43 tests',
      '{ seed: 222, path: "42:0:0", endOnFailure: true }',
    ].join('\n')
    const body = runReport('Deep fuzz — all suites', multiFailLog)

    // seed 222 + path index 42 → FUZZ_RUNS 43, never seed 111.
    expect(body).toContain('FUZZ_SEED=222 FUZZ_RUNS=43 yarn vitest run')
    expect(body).not.toContain('FUZZ_SEED=111')
  })

  it('picks the replayable section when an earlier failed step is a seed-only interruption', () => {
    // Both nightly steps failed: the sweep interrupted (seed, no path — not
    // replayable), the stateful step has a real seed+path. The regenerate
    // command must come from the section that carries the path, not stop on the
    // earlier seed-only one and be dropped.
    const sweepSeedOnly = [
      ' FAIL  src/data/api/blockData.fuzz.test.ts > suite > property A',
      'Error: Property interrupted after 0 tests',
      '{ seed: 111, endOnFailure: true }',
    ].join('\n')
    const statefulWithPath = [
      ' FAIL  src/data/test/repoMutators.fuzz.test.ts > suite > property B',
      'Error: Property failed after 43 tests',
      '{ seed: 222, path: "42:0:0", endOnFailure: true }',
    ].join('\n')
    const body = runReportSections([
      {name: 'Deep fuzz — all suites', log: sweepSeedOnly},
      {name: 'Deep fuzz — stateful data-layer suite (long pass)', log: statefulWithPath},
    ])

    expect(body).toContain('FUZZ_SEED=222 FUZZ_RUNS=43 yarn vitest run')
    expect(body).not.toContain('FUZZ_SEED=111')
  })

  it('omits the regenerate command when no seed is reported (non-fast-check crash)', () => {
    const crashLog = [
      ' FAIL  src/data/test/setup.fuzz.test.ts',
      'ReferenceError: something is not defined',
    ].join('\n')
    const body = runReport('Deep fuzz — all suites', crashLog)

    expect(body).toContain('- `src/data/test/setup.fuzz.test.ts`')
    expect(body).toContain('FUZZ_PATH="<path>"') // generic replay hint still shown
    expect(body).not.toContain('FUZZ_RUNS=') // no seed/index → no regenerate line
  })
})
