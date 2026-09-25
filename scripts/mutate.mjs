#!/usr/bin/env node
/**
 * `pnpm mutate`: the one sanctioned way to apply and revert a mutation-test
 * edit (AGENTS.md "verifying a guard or fix").
 *
 *   pnpm mutate --file <path> (--delete <literal> | --edit <shell command>)
 *               --test <vitest file> [-t <name pattern>] [--no-baseline] [--timeout <s>]
 *
 * It never calls git: `git checkout -- <file>` restores HEAD, not the
 * pre-mutation bytes, and drops every uncommitted edit in the file.
 *
 * The last stdout line is the verdict. Exit: 0 PINNED, 1 UNPINNED, 2 no
 * verdict, 3 the file's bytes need attention (the restore could not be
 * verified, or the file changed during the run and those bytes were saved
 * aside), 128+n interrupted after a verified restore.
 *
 * One run per checkout at a time: vitest loads the whole module graph, so a
 * concurrent mutation anywhere in the checkout would decide this run's verdict.
 * State lives in <checkout>/tmp/mutate/: the lock, and per target a journal and
 * a snapshot kept until the restore is verified, so a run killed outright makes
 * the next run on that file refuse rather than snapshot mutated bytes as the
 * original. An UNPINNED result is re-checked with the file made to throw on
 * load: a test that still passes never loaded it (it imports a built copy, or
 * another checkout's), which is no verdict. Not restored: other files an --edit
 * command writes. Accepted: bytes another process writes to the file while the
 * --edit command itself runs read as part of the edit and are not saved aside.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { isMainModule } from './is-main-module.mjs'

const USAGE =
  'usage: pnpm mutate --file <path> (--delete <literal> | --edit <shell command>) ' +
  '--test <vitest file> [-t <name pattern>] [--no-baseline] [--timeout <seconds>]'
const DIFF_LINES = 12
const DEFAULT_TIMEOUT_S = 300
const PROBE = "throw new Error('pnpm mutate: reachability probe')\n"

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
      timeout: { type: 'string' },
    },
  })
  if (!values.file) throw new Error('--file is required')
  if (!values.test) throw new Error('--test is required')
  const hasDelete = values.delete !== undefined
  const hasEdit = values.edit !== undefined
  if (hasDelete && hasEdit) throw new Error('give --delete or --edit, not both')
  if (!hasDelete && !hasEdit) throw new Error('one of --delete or --edit is required')
  if (hasDelete && !values.delete) throw new Error('--delete text is empty')
  const timeoutS = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout)
  if (!(timeoutS > 0)) throw new Error('--timeout must be a positive number of seconds')
  return {
    cwd,
    file: resolve(cwd, values.file),
    test: resolve(cwd, values.test),
    mutation: hasDelete ? { kind: 'delete', text: values.delete } : { kind: 'edit', command: values.edit },
    testName: values.testNamePattern,
    baseline: !values['no-baseline'],
    timeoutMs: timeoutS * 1000,
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

const realOr = p => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const firstLine = s => String(s ?? '').trim().split('\n')[0]
const none = (reason, extra) => ({ kind: 'none', reason, ...extra })
const nameOf = a => [...a.ancestorTitles, a.title].join(' > ')

/**
 * A vitest JSON report → the verdict for one test file. loadFailed marks a
 * file that failed outside any test, which is how a module throwing on load
 * shows up.
 */
export const verdictOf = (report, testFile) => {
  const file = report?.testResults?.find(r => realOr(r.name) === realOr(testFile))
  if (!file) return none(`${testFile} did not run (the report has no entry for it)`)
  const ran = file.assertionResults.filter(a => a.status === 'passed' || a.status === 'failed')
  const failed = ran.filter(a => a.status === 'failed')
  if (file.status === 'failed' && failed.length === 0) {
    const where = file.assertionResults.length ? 'failed outside any test' : 'failed to load'
    return none(`${testFile} ${where}: ${firstLine(file.message)}`, { loadFailed: true })
  }
  if (!ran.length) return none(`no test ran in ${testFile}`)
  const passed = ran.length - failed.length
  if (!failed.length) return { kind: 'unpinned', passed }
  return {
    kind: 'pinned',
    names: failed.map(nameOf),
    failures: failed.map(a => `${nameOf(a)}: ${firstLine(a.failureMessages?.[0])}`),
    passed,
  }
}

/** Where a run in checkout `root` keeps its lock, and its state for `target`. */
export const statePaths = (root, target) => {
  const dir = join(root, 'tmp', 'mutate')
  const key = createHash('sha256').update(realOr(target)).digest('hex').slice(0, 16)
  const base = join(dir, `${basename(target)}.${key}`)
  return {
    dir,
    lock: join(dir, 'lock.json'),
    report: join(dir, 'report.json'),
    journal: `${base}.journal.json`,
    snapshot: `${base}.orig`,
    duringRun: `${base}.during-run`,
  }
}

// ---------------------------------------------------------------------------

const log = s => process.stdout.write(`${s}\n`)
const readOrNull = p => {
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}
const readJson = p => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}
const tail = s => String(s).trim().split('\n').slice(-5).join('\n')

let interrupted = null
let active = null

// Children run in their own process group, so a signal or a timeout reaches
// vitest's workers too, not only its main process.
const killGroup = (child, sig) => {
  try {
    process.kill(-child.pid, sig)
  } catch {
    /* the group is already gone */
  }
}

const run = (cmd, args, opts, timeoutMs) =>
  new Promise(done => {
    // Defence in depth: a signal between two steps finds no child to kill, so
    // the next step must not start one. The window is too narrow to pin.
    if (interrupted) return done({ code: null, stderr: `not started: ${interrupted}` })
    let stderr = ''
    let settled = false
    let timedOut = false
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGKILL')
    }, timeoutMs)
    const settle = code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active = null
      done({ code, stderr, timedOut })
    }
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

const runVitest = async (cfg, paths) => {
  rmSync(paths.report, { force: true })
  const args = [vitestBin(), 'run', cfg.test, '--reporter=json', `--outputFile=${paths.report}`]
  if (cfg.testName !== undefined) args.push('--testNamePattern', cfg.testName)
  const { code, stderr, timedOut } = await run(process.execPath, args, { cwd: process.cwd() }, cfg.timeoutMs)
  const raw = readOrNull(paths.report)
  rmSync(paths.report, { force: true })
  if (timedOut) return none(`vitest did not finish within ${cfg.timeoutMs / 1000}s; its process group was killed`)
  if (!raw) return none(`vitest exited ${code} without a report: ${tail(stderr)}`)
  const verdict = verdictOf(JSON.parse(raw.toString('utf8')), cfg.test)
  // A suite-level error (an unhandled rejection) fails the run with every test passed.
  if (verdict.kind === 'unpinned' && code !== 0) {
    return none(`vitest exited ${code} though no test failed: ${tail(stderr)}`)
  }
  return verdict
}

const printEdit = (before, after) => {
  const { removed, added } = changedLines(before.toString('utf8'), after.toString('utf8'))
  log(`edit: ${removed.length} line(s) removed, ${added.length} added`)
  const shown = [...removed.map(l => `  - ${l.trim()}`), ...added.map(l => `  + ${l.trim()}`)]
  for (const l of shown.slice(0, DIFF_LINES)) log(l)
  if (shown.length > DIFF_LINES) log(`  …and ${shown.length - DIFF_LINES} more changed lines`)
}

class ChangedDuringRun extends Error {}

/** Write the target, unless something else changed it since this run last wrote it. */
const writeTarget = (cfg, state, bytes) => {
  if (!readOrNull(cfg.file)?.equals(state.expected)) throw new ChangedDuringRun()
  writeFileSync(cfg.file, bytes)
  state.expected = bytes
}

/** Baseline, edit, mutated run, reachability probe → verdict. */
const mutateAndRun = async (cfg, paths, state) => {
  const { original } = state
  let deleted = null
  if (cfg.mutation.kind === 'delete') {
    try {
      deleted = Buffer.from(deleteOnce(original.toString('utf8'), cfg.mutation.text), 'utf8')
    } catch (e) {
      return none(e.message) // before the baseline: a mistyped literal costs no test run
    }
  }

  if (cfg.baseline) {
    const b = await runVitest(cfg, paths)
    if (b.kind === 'none') return none(`baseline: ${b.reason}`)
    if (b.kind === 'pinned') {
      log(`baseline: ${b.passed} passed, ${b.names.length} failed (${b.names.join('; ')})`)
      return none('the test file fails before any edit')
    }
    log(`baseline: ${b.passed} passed, 0 failed`)
  }

  if (deleted) {
    writeTarget(cfg, state, deleted)
  } else {
    if (!readOrNull(cfg.file)?.equals(state.expected)) throw new ChangedDuringRun()
    const r = await run(
      '/bin/sh',
      ['-c', cfg.mutation.command],
      { cwd: cfg.cwd, env: { ...process.env, MUTATE_FILE: cfg.file } },
      cfg.timeoutMs,
    )
    state.expected = readOrNull(cfg.file) ?? Buffer.alloc(0)
    if (r.code !== 0) return none(`the --edit command exited ${r.code}: ${tail(r.stderr)}`)
  }
  if (state.expected.equals(original)) return none(`the edit did not change ${relative(cfg.cwd, cfg.file)}`)
  printEdit(original, state.expected)

  const verdict = await runVitest(cfg, paths)
  if (verdict.kind !== 'unpinned') return verdict
  writeTarget(cfg, state, Buffer.concat([Buffer.from(PROBE), original]))
  const probe = await runVitest(cfg, paths)
  if (probe.kind === 'unpinned') {
    return none(`${relative(cfg.cwd, cfg.file)} is not loaded by ${relative(cfg.cwd, cfg.test)}: it passed with the file throwing on load`)
  }
  // Defence in depth: a probe that did not report (a timeout, a crash) proves nothing either way.
  if (probe.kind === 'none' && !probe.loadFailed) return none(`reachability probe: ${probe.reason}`)
  return verdict
}

/**
 * Put the original bytes back and compare. Bytes this run did not write are
 * saved aside first, so an edit made during the run is not lost to the restore.
 */
const restore = (cfg, paths, state) => {
  const current = readOrNull(cfg.file)
  let savedAside = null
  if (current && !current.equals(state.expected) && !current.equals(state.original)) {
    writeFileSync(paths.duringRun, current)
    savedAside = paths.duringRun
  }
  try {
    if (!current?.equals(state.original)) writeFileSync(cfg.file, state.original)
  } catch {
    /* the comparison below reports it */
  }
  return { verified: readOrNull(cfg.file)?.equals(state.original) ?? false, savedAside }
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * Take the checkout lock, or return the facts about the run holding it. A lock
 * whose process is gone is taken over. Accepted: two runs taking over the same
 * dead lock at the same instant can both proceed.
 */
const takeLock = lock => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' })
      return null
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const held = readJson(lock)
    if (isAlive(held.pid)) {
      return `another pnpm mutate (pid ${held.pid}, started ${held.started}) is running in this checkout; lock: ${lock}`
    }
    rmSync(lock, { force: true })
  }
  return `another pnpm mutate took the lock at the same moment; lock: ${lock}`
}

// Defence in depth: after a takeover race the lock may name another run.
const releaseLock = lock => {
  if (readJson(lock).pid === process.pid) rmSync(lock, { force: true })
}

/** Facts about a journal an earlier run left, or null when it is safe to proceed. */
const leftoverJournal = (paths, file) => {
  if (!existsSync(paths.journal)) return null
  const j = readJson(paths.journal)
  const snap = readOrNull(paths.snapshot)
  if (snap && snap.equals(readOrNull(file) ?? Buffer.alloc(0))) {
    rmSync(paths.journal, { force: true }) // it was restored; only the cleanup was lost
    rmSync(paths.snapshot, { force: true })
    return null
  }
  return [
    `an earlier pnpm mutate of ${file} (pid ${j.pid}, started ${j.started}) exited without a verified restore.`,
    `its snapshot of the pre-mutation bytes: ${paths.snapshot}${snap ? '' : ' (missing)'}`,
    `the file now differs from that snapshot.`,
    `journal: ${paths.journal}`,
  ].join('\n')
}

/** Everything after the lock is held: snapshot, run, restore, verdict → exit code. */
const mutateLocked = async (cfg, paths) => {
  const leftover = leftoverJournal(paths, cfg.file)
  if (leftover) {
    log(`${leftover}\nNO VERDICT: refusing to snapshot ${cfg.file} over that journal`)
    return 2
  }
  const original = readFileSync(cfg.file)
  writeFileSync(paths.snapshot, original)
  writeFileSync(paths.journal, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))

  const rel = relative(cfg.cwd, cfg.file)
  log(`mutate: ${rel} (snapshot: ${paths.snapshot})`)
  const state = { original, expected: original }
  let verdict
  let restored
  try {
    verdict = await mutateAndRun(cfg, paths, state)
  } catch (e) {
    verdict = e instanceof ChangedDuringRun ? none(`${rel} changed during the run`) : none(`internal error: ${e?.message ?? e}`)
  } finally {
    restored = restore(cfg, paths, state)
  }

  if (!restored.verified) {
    log(`RESTORE FAILED: ${cfg.file} does not match its snapshot ${paths.snapshot}; journal kept: ${paths.journal}`)
    return 3
  }
  rmSync(paths.journal, { force: true })
  rmSync(paths.snapshot, { force: true })
  log(`restored: ${rel}, bytes verified`)
  if (restored.savedAside) {
    log(`CHANGED DURING RUN: ${rel} held bytes this run did not write; saved at ${restored.savedAside}`)
    return 3
  }
  if (interrupted) {
    log(`interrupted by ${interrupted}`)
    return 128 + constants.signals[interrupted]
  }
  if (verdict.kind === 'pinned') {
    for (const f of verdict.failures) log(`  ${f}`)
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

const main = async () => {
  let cfg
  try {
    cfg = parseMutateArgs(process.argv.slice(2), process.env.INIT_CWD || process.cwd())
  } catch (e) {
    log(`NO VERDICT: ${e.message}\n${USAGE}`)
    return 2
  }
  const root = realpathSync(process.cwd())
  for (const p of [cfg.file, cfg.test]) {
    if (!existsSync(p)) {
      log(`NO VERDICT: ${p} does not exist`)
      return 2
    }
    if (!realOr(p).startsWith(root + sep)) {
      log(`NO VERDICT: ${p} is outside ${root}, the checkout vitest runs in`)
      return 2
    }
  }
  const paths = statePaths(root, cfg.file)
  mkdirSync(paths.dir, { recursive: true })
  chmodSync(paths.dir, 0o700) // snapshots hold source; a mkdir mode would reach only a new directory
  const held = takeLock(paths.lock)
  if (held) {
    log(`NO VERDICT: ${held}`)
    return 2
  }
  const onSignal = sig => {
    interrupted ??= sig
    // To the group, not only vitest's main process: a worker spinning in
    // synchronous code outlives vitest's own shutdown. Defence in depth for a
    // worker that responds, which is every case the tests can drive.
    if (active) killGroup(active, sig)
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, onSignal)
  try {
    return await mutateLocked(cfg, paths)
  } finally {
    releaseLock(paths.lock)
  }
}

if (isMainModule(import.meta.url)) {
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
