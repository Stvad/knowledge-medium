#!/usr/bin/env node
/**
 * `pnpm mutate`: the one sanctioned way to apply and revert a mutation-test
 * edit (AGENTS.md "verifying a guard or fix").
 *
 *   pnpm mutate --file <path> (--delete <literal> | --edit <shell command>)
 *               --test <vitest file> [-t <name pattern>] [--no-baseline]
 *
 * The restore agents improvised, `git checkout -- <file>`, restores HEAD, not
 * the pre-mutation tree, so every uncommitted edit in the file went with it.
 * This helper never calls git. It:
 *   1. snapshots the target's bytes to disk, with a journal naming the
 *      snapshot, both kept until the restore is verified;
 *   2. runs the test file unmutated (unless --no-baseline); any failure there
 *      means no verdict, since a pre-existing failure would read as a pin;
 *   3. applies the edit: --delete removes a literal that must occur exactly
 *      once, --edit runs a shell command with MUTATE_FILE set; an edit that
 *      leaves the bytes unchanged means no verdict;
 *   4. runs that one vitest file, filtered by -t when given;
 *   5. restores the bytes in a finally that SIGINT, SIGTERM and SIGHUP also
 *      reach, and compares them byte for byte.
 *
 * Exit: 0 PINNED, 1 UNPINNED, 2 no verdict, 3 the restore could not be
 * verified (snapshot and journal kept), 128+n interrupted after a verified
 * restore. The last stdout line is the verdict.
 *
 * A run killed outright (SIGKILL) cannot restore; the journal it leaves makes
 * the next run on the same file refuse rather than snapshot mutated bytes as
 * the original. Only the target is snapshotted: an --edit command that writes
 * other files is not undone.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const USAGE =
  'usage: pnpm mutate --file <path> (--delete <literal> | --edit <shell command>) ' +
  '--test <vitest file> [-t <name pattern>] [--no-baseline]'
const DIFF_LINES = 12

/** CLI arguments → config; paths resolve against the directory pnpm was invoked from. */
export const parseMutateArgs = (argv, cwd) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      test: { type: 'string' },
      delete: { type: 'string' },
      edit: { type: 'string' },
      testNamePattern: { type: 'string', short: 't' },
      'no-baseline': { type: 'boolean' },
    },
  })
  if (!values.file) throw new Error('--file is required')
  if (!values.test) throw new Error('--test is required')
  const hasDelete = values.delete !== undefined
  const hasEdit = values.edit !== undefined
  if (hasDelete && hasEdit) throw new Error('give --delete or --edit, not both')
  if (!hasDelete && !hasEdit) throw new Error('one of --delete or --edit is required')
  if (hasDelete && !values.delete) throw new Error('--delete text is empty')
  return {
    cwd,
    file: resolve(cwd, values.file),
    test: resolve(cwd, values.test),
    mutation: hasDelete ? { kind: 'delete', text: values.delete } : { kind: 'edit', command: values.edit },
    testName: values.testNamePattern,
    baseline: !values['no-baseline'],
  }
}

export const deleteOnce = (text, literal) => {
  const n = text.split(literal).length - 1
  if (n !== 1) throw new Error(`the --delete text occurs ${n} times in the file; it must occur exactly once`)
  return text.replace(literal, () => '')
}

/** Lines between the common prefix and the common suffix of two texts. */
export const changedLines = (before, after) => {
  const a = before.split('\n')
  const b = after.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) }
}

const samePath = (x, y) => {
  const real = p => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  return real(x) === real(y)
}

const firstLine = s => String(s ?? '').trim().split('\n')[0]

/** A vitest JSON report → the verdict for one test file. */
export const verdictOf = (report, testFile) => {
  const file = report?.testResults?.find(r => samePath(r.name, testFile))
  if (!file) return { kind: 'none', reason: `${testFile} did not run (the report has no entry for it)` }
  const ran = file.assertionResults.filter(a => a.status === 'passed' || a.status === 'failed')
  const failed = ran.filter(a => a.status === 'failed')
  if (file.status === 'failed' && failed.length === 0) {
    const where = file.assertionResults.length ? 'failed outside any test' : 'failed to load'
    return { kind: 'none', reason: `${testFile} ${where}: ${firstLine(file.message)}` }
  }
  if (!ran.length) return { kind: 'none', reason: `no test ran in ${testFile}` }
  const passed = ran.length - failed.length
  if (!failed.length) return { kind: 'unpinned', passed }
  return { kind: 'pinned', names: failed.map(a => [...a.ancestorTitles, a.title].join(' > ')), passed }
}

export const journalPaths = target => {
  const dir = join(tmpdir(), 'km-mutate')
  const key = createHash('sha256').update(resolve(target)).digest('hex').slice(0, 16)
  return {
    dir,
    journal: join(dir, `${key}.json`),
    snapshot: join(dir, `${basename(target)}.${key}.orig`),
    report: label => join(dir, `${key}.${label}.json`),
  }
}

// ---------------------------------------------------------------------------

const log = s => process.stdout.write(`${s}\n`)
const none = reason => ({ kind: 'none', reason })
const readOrNull = p => {
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}
const tail = s => String(s).trim().split('\n').slice(-5).join('\n')

let interrupted = null
let active = null

const run = (cmd, args, opts) =>
  new Promise(done => {
    let stderr = ''
    let settled = false
    const settle = code => {
      if (settled) return
      settled = true
      active = null
      done({ code, stderr })
    }
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'ignore', 'pipe'] })
    active = child
    child.stderr.on('data', d => {
      stderr = (stderr + d).slice(-20_000)
    })
    child.on('error', e => {
      stderr += String(e)
      settle(-1)
    })
    child.on('close', code => settle(code))
  })

const vitestBin = () =>
  join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')

const runVitest = async (cfg, paths, label) => {
  const out = paths.report(label)
  rmSync(out, { force: true })
  const rel = relative(process.cwd(), cfg.test)
  const filter = rel.startsWith('..') ? cfg.test : rel
  const args = [vitestBin(), 'run', filter, '--reporter=json', `--outputFile=${out}`]
  if (cfg.testName !== undefined) args.push('--testNamePattern', cfg.testName)
  const { code, stderr } = await run(process.execPath, args, { cwd: process.cwd() })
  const raw = readOrNull(out)
  rmSync(out, { force: true })
  if (!raw) return none(`vitest exited ${code} without a report: ${tail(stderr)}`)
  return verdictOf(JSON.parse(raw.toString('utf8')), cfg.test)
}

const printEdit = (before, after) => {
  const { removed, added } = changedLines(before.toString('utf8'), after.toString('utf8'))
  log(`edit: ${removed.length} line(s) removed, ${added.length} added`)
  const shown = [...removed.map(l => `  - ${l.trim()}`), ...added.map(l => `  + ${l.trim()}`)]
  for (const l of shown.slice(0, DIFF_LINES)) log(l)
  if (shown.length > DIFF_LINES) log(`  …and ${shown.length - DIFF_LINES} more changed lines`)
}

/** Baseline, edit, mutated run. Returns a verdict, or null once interrupted. */
const mutateAndRun = async (cfg, paths, original) => {
  if (cfg.baseline) {
    const b = await runVitest(cfg, paths, 'baseline')
    if (interrupted) return null
    if (b.kind === 'none') return none(`baseline: ${b.reason}`)
    if (b.kind === 'pinned') {
      log(`baseline: ${b.passed} passed, ${b.names.length} failed (${b.names.join('; ')})`)
      return none('the test file fails before any edit')
    }
    log(`baseline: ${b.passed} passed, 0 failed`)
  }

  let mutated
  if (cfg.mutation.kind === 'delete') {
    try {
      mutated = Buffer.from(deleteOnce(original.toString('utf8'), cfg.mutation.text), 'utf8')
    } catch (e) {
      return none(e.message)
    }
    writeFileSync(cfg.file, mutated)
  } else {
    const r = await run('/bin/sh', ['-c', cfg.mutation.command], {
      cwd: cfg.cwd,
      env: { ...process.env, MUTATE_FILE: cfg.file },
    })
    if (interrupted) return null
    if (r.code !== 0) return none(`the --edit command exited ${r.code}: ${tail(r.stderr)}`)
    mutated = readOrNull(cfg.file) ?? Buffer.alloc(0)
  }
  if (mutated.equals(original)) return none(`the edit did not change ${relative(cfg.cwd, cfg.file)}`)
  printEdit(original, mutated)
  if (interrupted) return null
  return runVitest(cfg, paths, 'mutated')
}

/** Write the snapshot back when the file differs from it, then compare. */
const restore = (file, original) => {
  try {
    if (!readOrNull(file)?.equals(original)) writeFileSync(file, original)
  } catch {
    /* the comparison below reports it */
  }
  return readOrNull(file)?.equals(original) ?? false
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Facts about a journal an earlier run left, or null when it is safe to proceed. */
const leftoverJournal = (paths, file) => {
  const raw = readOrNull(paths.journal)
  if (!raw) return null
  let j = {}
  try {
    j = JSON.parse(raw.toString('utf8'))
  } catch {
    /* unreadable journal: reported below with what is known */
  }
  if (isAlive(j.pid)) {
    return `another pnpm mutate (pid ${j.pid}, started ${j.started}) holds ${file}; journal: ${paths.journal}`
  }
  const snap = readOrNull(j.snapshot ?? paths.snapshot)
  if (snap && snap.equals(readOrNull(file) ?? Buffer.alloc(0))) {
    rmSync(paths.journal, { force: true }) // it was restored; only the cleanup was lost
    rmSync(paths.snapshot, { force: true })
    return null
  }
  return [
    `an earlier pnpm mutate of ${file} (pid ${j.pid}, started ${j.started}) exited without a verified restore.`,
    `its snapshot of the pre-mutation bytes: ${j.snapshot ?? paths.snapshot}${snap ? '' : ' (missing)'}`,
    `the file now differs from that snapshot.`,
    `journal: ${paths.journal}`,
  ].join('\n')
}

const main = async () => {
  let cfg
  try {
    cfg = parseMutateArgs(process.argv.slice(2), process.env.INIT_CWD || process.cwd())
  } catch (e) {
    log(`NO VERDICT: ${e.message}\n${USAGE}`)
    return 2
  }
  for (const p of [cfg.file, cfg.test]) {
    if (!existsSync(p)) {
      log(`NO VERDICT: ${p} does not exist`)
      return 2
    }
  }
  const paths = journalPaths(cfg.file)
  const leftover = leftoverJournal(paths, cfg.file)
  if (leftover) {
    log(`${leftover}\nNO VERDICT: refusing to snapshot ${cfg.file} over that journal`)
    return 2
  }

  const original = readFileSync(cfg.file)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.snapshot, original)
  writeFileSync(
    paths.journal,
    JSON.stringify({ target: cfg.file, snapshot: paths.snapshot, pid: process.pid, started: new Date().toISOString() }),
  )
  const onSignal = sig => {
    interrupted ??= sig
    active?.kill(sig)
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, onSignal)

  const rel = relative(cfg.cwd, cfg.file)
  log(`mutate: ${rel} (snapshot: ${paths.snapshot})`)
  let verdict
  let restored = false
  try {
    verdict = await mutateAndRun(cfg, paths, original)
  } catch (e) {
    verdict = none(`internal error: ${e?.message ?? e}`)
  } finally {
    restored = restore(cfg.file, original)
  }

  if (!restored) {
    log(`RESTORE FAILED: ${cfg.file} does not match its snapshot ${paths.snapshot}; journal kept: ${paths.journal}`)
    return 3
  }
  rmSync(paths.journal, { force: true })
  rmSync(paths.snapshot, { force: true })
  log(`restored: ${rel}, bytes verified`)
  if (interrupted) {
    log(`interrupted by ${interrupted}`)
    return 128 + constants.signals[interrupted]
  }
  if (verdict.kind === 'pinned') {
    log(`PINNED by: ${verdict.names.join('; ')}`)
    return 0
  }
  if (verdict.kind === 'unpinned') {
    log(`UNPINNED: ${verdict.passed} passed, 0 failed`)
    return 1
  }
  log(`NO VERDICT: ${verdict.reason}`)
  return 2
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().then(
    code => {
      process.exitCode = code
    },
    e => {
      log(`NO VERDICT: internal error: ${e?.stack ?? e}`)
      process.exitCode = 2
    },
  )
}
