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
 */
import { spawnSync } from 'node:child_process'

const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
const timeMs = Number(process.env.FUZZ_TIME_MS ?? 15_000)
// Headroom over the generation budget: shrinking a failure replays many
// smaller cases after the time limit interrupts generation.
const testTimeout = timeMs * 4 + 180_000

const extra = process.argv.slice(2)
const files = extra.length > 0 ? extra : ['fuzz.test.']

const result = spawnSync(
  yarn,
  ['vitest', 'run', '--testTimeout', String(testTimeout), ...files],
  {
    stdio: 'inherit',
    env: {...process.env, FUZZ_TIME_MS: String(timeMs)},
  },
)
process.exit(result.status ?? 1)
