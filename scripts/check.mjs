#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { extractFailingFiles } from './fuzz.mjs'
import { isMainModule } from './is-main-module.mjs'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// First: every task below reads node_modules. A worktree DIRECTORY outlives the
// branch checked out in it, so a clean tree at current master can sit over a
// weeks-old install — git refreshes package.json and the lockfile, nothing
// re-runs install. `--frozen-lockfile` also DOWNGRADES a package left newer than
// the branch asks for; that is the same invariant, not a regression. Keep the
// purge flag: tasks here are spawned with no stdin, and an install that has to
// recreate node_modules aborts without a TTY — which would hard-fail the gate on
// exactly the stale worktrees this step exists to repair.
const installTask = {
  name: 'install',
  args: ['install', '--frozen-lockfile', '--config.confirm-modules-purge=false'],
}

const compileTask = {
  name: 'compile',
  args: ['run', 'compile'],
}

const testTask = {name: 'test', args: ['run', 'test']}

const parallelTasks = [
  {name: 'lint', args: ['run', 'lint']},
  testTask,
  {name: 'check:sync-config', args: ['run', 'check:sync-config']},
  {name: 'check:ambient-accessors', args: ['run', 'check:ambient-accessors']},
  {name: 'check:rpc-projections', args: ['run', 'check:rpc-projections']},
  {name: 'check:no-service-role', args: ['run', 'check:no-service-role']},
]

// Gates on one machine share its cores, and each one's vitest already asks for
// all of them (`maxWorkers: '100%'`), so past this many at once the parallel
// phase only gets slower for everyone.
const SLOTS_ENV = 'KM_CHECK_SLOTS'
const DEFAULT_SLOTS = 2
// The cap may cost a gate latency, never progress: past this it runs anyway.
const SLOT_WAIT_MS = 15 * 60_000
const SLOT_POLL_MS = 2_000
// Re-running more failing files than this, one at a time, costs about what the
// suite does.
const RERUN_MAX_FILES = 25

const running = new Set()

const formatDuration = ms => `${(ms / 1000).toFixed(2)}s`

const formatCommand = task => `${pnpm} ${task.args.join(' ')}`

const isRunning = state =>
  state.child && state.child.exitCode === null && state.child.signalCode === null

const stopTask = state => {
  if (!isRunning(state)) return
  state.canceled = true
  state.child.kill('SIGTERM')
  setTimeout(() => {
    if (isRunning(state)) state.child.kill('SIGKILL')
  }, 5_000).unref()
}

const stopAll = except => {
  for (const state of running) {
    if (state !== except) stopTask(state)
  }
}

const printResult = result => {
  const status = result.canceled
    ? `canceled via ${result.signal ?? 'signal'}`
    : result.code === 0
      ? 'passed'
      : `failed with exit code ${result.code ?? 1}`
  const stream = result.code === 0 && !result.canceled ? process.stdout : process.stderr
  stream.write(`[check] ${result.task.name} ${status} (${formatDuration(result.durationMs)})\n`)
  for (const chunk of result.output) {
    const target = chunk.stream === 'stderr' ? process.stderr : process.stdout
    target.write(chunk.text)
  }
  const lastChunk = result.output.at(-1)
  if (lastChunk && !lastChunk.text.endsWith('\n')) stream.write('\n')
}

const startTask = task => {
  const state = {
    task,
    child: null,
    output: [],
    canceled: false,
    startedAt: performance.now(),
    promise: null,
  }

  console.log(`[check] starting ${task.name}: ${formatCommand(task)}`)

  state.promise = new Promise(resolve => {
    const child = spawn(pnpm, task.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    state.child = child
    running.add(state)

    child.stdout.on('data', chunk => {
      state.output.push({stream: 'stdout', text: chunk.toString()})
    })
    child.stderr.on('data', chunk => {
      state.output.push({stream: 'stderr', text: chunk.toString()})
    })
    child.on('error', error => {
      state.output.push({stream: 'stderr', text: `${error.stack ?? error.message}\n`})
    })
    child.on('close', (code, signal) => {
      running.delete(state)
      resolve({
        task,
        output: state.output,
        canceled: state.canceled,
        code,
        signal,
        durationMs: performance.now() - state.startedAt,
      })
    })
  })

  return state
}

const runTask = async task => {
  const state = startTask(task)
  const result = await state.promise
  printResult(result)
  return result
}

const isFailure = result => !result.canceled && result.code !== 0

const runParallel = async tasks => {
  let failed = false
  const states = tasks.map(startTask)
  return Promise.all(states.map(async state => {
    const result = await state.promise
    printResult(result)
    if (!failed && isFailure(result)) {
      failed = true
      stopAll(state)
    }
    return result
  }))
}

const pidAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readHolder = path => {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8'))
    return Number.isInteger(holder?.pid) ? holder : null
  } catch {
    return null
  }
}

const tryLink = (from, to) => {
  try {
    linkSync(from, to)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

// Moves a stale record aside rather than deleting it: by now the waiter that
// read the dead holder may be looking at a record a faster waiter put there,
// and that one goes back.
export const clearStaleSlot = (path, scratch) => {
  try {
    renameSync(path, scratch)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const moved = readHolder(scratch)
  if (moved && pidAlive(moved.pid)) tryLink(scratch, path)
  rmSync(scratch, {force: true})
}

// A slot is a file naming its holder, published whole by hard-linking a
// finished record: link refuses an existing name, so two gates cannot both take
// a free slot and no reader sees a half-written one. Accepted: a waiter linking
// between another's move and put-back leaves the moved holder running
// uncounted, one gate over the cap; a dead holder whose pid is reused keeps its
// slot until the wait runs out.
const takeSlot = (path, record) => {
  if (tryLink(record, path)) return {taken: true}
  const holder = readHolder(path)
  // Here and not left to clearStaleSlot's put-back: moving a live record aside,
  // however briefly, opens its slot to another waiter.
  if (holder && pidAlive(holder.pid)) return {taken: false, holder}
  clearStaleSlot(path, `${record}.stale`)
  if (tryLink(record, path)) return {taken: true, reclaimed: holder}
  return {taken: false, holder: readHolder(path)}
}

const describeHolder = holder => holder
  ? `${holder.worktree} (${holder.branch}, pid ${holder.pid}, started ${formatDuration(Date.now() - holder.startedAt)} ago)`
  : 'an unreadable holder'

export const acquireSlot = async ({
  dir,
  slots,
  holder,
  maxWaitMs = SLOT_WAIT_MS,
  pollMs = SLOT_POLL_MS,
  signal,
  log = console.log,
}) => {
  mkdirSync(dir, {recursive: true})
  const record = join(dir, `.${randomUUID()}.tmp`)
  writeFileSync(record, JSON.stringify(holder))
  const startedAt = Date.now()
  let reported = null
  try {
    for (;;) {
      const holders = []
      for (let i = 0; i < slots; i++) {
        const path = join(dir, `slot-${i}`)
        const result = takeSlot(path, record)
        if (result.taken) {
          if (result.reclaimed) log(`[check] reclaimed a gate slot from ${describeHolder(result.reclaimed)}, which is no longer running`)
          if (reported !== null) log(`[check] got a gate slot after waiting ${formatDuration(Date.now() - startedAt)}`)
          return {
            // Only our own record: in the accepted race above, another gate
            // may hold this slot now.
            release: () => {
              if (readHolder(path)?.pid === holder.pid) rmSync(path, {force: true})
            },
          }
        }
        holders.push(result.holder)
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        log(`[check] waited ${formatDuration(Date.now() - startedAt)} for a gate slot; running anyway`)
        return null
      }
      const key = holders.map(h => h?.pid).join()
      if (key !== reported) {
        log(`[check] all ${slots} gate slot(s) are taken, waiting up to ${formatDuration(maxWaitMs)} (${SLOTS_ENV} sets the cap):`)
        for (const h of holders) log(`[check]   ${describeHolder(h)}`)
        reported = key
      }
      await sleep(pollMs, undefined, {signal})
    }
  } catch (error) {
    if (signal?.aborted) return null
    throw error
  } finally {
    rmSync(record, {force: true})
  }
}

const git = args => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()

// Never fails the gate: a cap it cannot set up is a cap it runs without. A
// gate that dies holding a slot frees it by dying (see takeSlot).
const takeGateSlot = async signal => {
  const configured = Number.parseInt(process.env[SLOTS_ENV], 10)
  const slots = configured > 0 ? configured : DEFAULT_SLOTS
  try {
    // The common dir, not the worktree's own: one cap for every worktree.
    // Separate clones each get their own; accepted, as sessions here are
    // worktrees of one clone.
    const dir = process.env.KM_CHECK_SLOT_DIR
      || join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'check-slots')
    const holder = {
      pid: process.pid,
      worktree: basename(process.cwd()),
      branch: git(['branch', '--show-current']) || 'detached HEAD',
      startedAt: Date.now(),
    }
    return await acquireSlot({dir, slots, holder, signal})
  } catch (error) {
    console.log(`[check] running without a gate slot: ${error.message}`)
    return null
  }
}

// `rerun` is the failing files' second run, alone. One that fails without
// naming a file blames all of them: never claim load without a pass to show.
export const loadVerdict = (failed, rerun) => {
  const named = extractFailingFiles(rerun.output)
  const failedAlone = rerun.code === 0 ? [] : named.length ? named : failed
  const passedAlone = failed.filter(file => !failedAlone.includes(file))
  if (failedAlone.length === 0) return `failed only under load, passed alone: ${passedAlone.join(', ')}`
  const rest = passedAlone.length ? `; passed alone: ${passedAlone.join(', ')}` : ''
  return `fails alone too: ${failedAlone.join(', ')}${rest}`
}

const outputText = result => result.output.map(chunk => chunk.text).join('')

// Every file is re-run, not only timed-out ones: a starved `vi.waitFor` fails
// with its last assertion error, not a timeout. One file at a time, so a
// verdict is about that file alone and not the load of the others. On stdout,
// beside the last line, for a reader piping through `tail`.
const diagnoseTestFailure = async result => {
  const failed = extractFailingFiles(outputText(result))
  if (failed.length === 0) {
    console.log('[check] the test task named no failing file; nothing to re-run')
    return
  }
  if (failed.length > RERUN_MAX_FILES) {
    console.log(`[check] ${failed.length} test files failed; too many to re-run alone`)
    return
  }
  const rerun = await runTask({name: 'test (failing files, alone)', args: [...testTask.args, '--no-file-parallelism', ...failed]})
  if (rerun.canceled) return
  console.log(`[check] verdict: ${loadVerdict(failed, {code: rerun.code, output: outputText(rerun)})}`)
}

// Returns the exit code rather than taking it: every failure path here has
// just relayed a failing task's entire output, and `process.exit()` drops what
// is still queued on a piped stdout once the writes outrun the reader, which a
// failing task's output does comfortably. Nothing is still running when any of
// these returns, so the loop drains and ends.
const runGate = async signal => {
  const startedAt = performance.now()
  const loadAtStart = loadavg()[0]
  // The last line, whatever came before: a reader piping through `tail` sees
  // the verdict even though the pipe hides the exit status. Written once stderr
  // has drained, since in a `2>&1` pipe a backlog there would land after it.
  const finish = async (failures = []) => {
    const passed = failures.length === 0 && !signal.aborted
    const duration = formatDuration(performance.now() - startedAt)
    console.log(`[check] load average ${loadAtStart.toFixed(1)} at start, ${loadavg()[0].toFixed(1)} at end, on ${availableParallelism()} cores`)
    console[passed ? 'log' : 'error'](`[check] ${passed ? 'passed' : 'failed'} in ${duration}`)
    await new Promise(resolve => process.stderr.write('', resolve))
    const failed = signal.aborted ? 'interrupted' : failures.map(result => result.task.name).join(', ')
    console.log(passed ? 'check: PASS' : `check: FAIL (${failed})`)
    return passed ? 0 : failures[0]?.code ?? 1
  }

  for (const task of [installTask, compileTask]) {
    const result = await runTask(task)
    if (result.code !== 0) return finish([result])
  }

  const slot = await takeGateSlot(signal)
  if (signal.aborted) return finish()

  console.log(`[check] running ${parallelTasks.map(task => task.name).join(', ')} in parallel`)
  const results = await runParallel(parallelTasks)
  const failures = results.filter(isFailure)
  const testResult = failures.find(result => result.task === testTask)
  // Aborted while the other tasks wound down: the re-run would start anyway.
  if (testResult && !signal.aborted) await diagnoseTestFailure(testResult)
  slot?.release()
  return finish(failures)
}

const main = async () => {
  const abort = new AbortController()
  const abortFromSignal = signal => {
    abort.abort()
    stopAll(null)
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  }
  process.once('SIGINT', () => abortFromSignal('SIGINT'))
  process.once('SIGTERM', () => abortFromSignal('SIGTERM'))

  const code = await runGate(abort.signal)
  // A signal already set 130/143 in abortFromSignal; keep it.
  if (code !== 0 && !abort.signal.aborted) process.exitCode = code
}

if (isMainModule(import.meta.url)) await main()
