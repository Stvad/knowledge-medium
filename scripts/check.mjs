#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { FROZEN_INSTALL_ARGS } from './ensure-deps.mjs'
import { extractFailingFiles } from './fuzz.mjs'
import { isMainModule } from './is-main-module.mjs'
import { pidAlive } from './pid-alive.mjs'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// First: every task below reads node_modules. ensure-deps.mjs repairs a reused
// checkout's drifted install at session start; the gate re-checks because a
// branch switch mid-session brings the drift back.
const installTask = {
  name: 'install',
  args: FROZEN_INSTALL_ARGS,
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
// Taking a ticket number takes microseconds, so a count held for one is soon retried.
const CHOOSING_RECHECK_MS = 10
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

const readHolder = path => {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8'))
    return Number.isInteger(holder?.pid) ? holder : null
  } catch {
    return null
  }
}

const describeHolder = holder => holder
  ? `${holder.worktree} (${holder.branch}, pid ${holder.pid}, started ${formatDuration(Date.now() - holder.startedAt)} ago)`
  : 'an unreadable holder'

const TICKET = /^(\d+)-([\w-]+)\.ticket$/
const CHOOSING = /^(\d+)-[\w-]+\.choosing$/

// A place in line: by ticket number, and by id between gates that took their
// numbers at the same moment.
export const placeOrder = (a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The live tickets, in line order. A dead gate's ticket is deleted: no ticket
// name is ever reused, so that can only free its place.
const liveTickets = (dir, log) => {
  const tickets = []
  for (const name of readdirSync(dir)) {
    const match = TICKET.exec(name)
    if (!match) continue
    const path = join(dir, name)
    const holder = readHolder(path)
    if (holder && pidAlive(holder.pid)) {
      tickets.push({number: Number(match[1]), id: match[2], holder})
    } else {
      rmSync(path, {force: true})
      log(`[check] dropped the place of ${describeHolder(holder)}: it is no longer running`)
    }
  }
  return tickets.sort(placeOrder)
}

// Whether a live gate is still taking its number, and so may yet land ahead.
const anyChoosing = dir => readdirSync(dir).some(name => {
  const match = CHOOSING.exec(name)
  if (!match) return false
  if (pidAlive(Number(match[1]))) return true
  rmSync(join(dir, name), {force: true})
  return false
})

// Gates line up by numbered ticket (Lamport's bakery): a ticket is one above
// every ticket in view, taken under a marker that holds the others' count until
// it is published, and a gate runs once fewer than `slots` live tickets are
// ahead of it. Accepted: a dead gate whose pid is reused keeps its place, or
// with a marker left mid-number holds every gate's count, until the wait runs out.
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
  const id = randomUUID()
  const marker = join(dir, `${holder.pid}-${id}.choosing`)
  writeFileSync(marker, '')
  let number, ticket
  try {
    number = 1 + Math.max(0, ...liveTickets(dir, log).map(other => other.number))
    ticket = join(dir, `${number}-${id}.ticket`)
    writeFileSync(`${ticket}.tmp`, JSON.stringify(holder))
    renameSync(`${ticket}.tmp`, ticket)
  } finally {
    // Even on a throw: a live gate's marker would hold every other gate back.
    rmSync(marker, {force: true})
  }
  const release = () => rmSync(ticket, {force: true})
  const startedAt = Date.now()
  let reported = null
  try {
    for (;;) {
      const choosing = anyChoosing(dir)
      if (!choosing) {
        const ahead = liveTickets(dir, log).filter(other => placeOrder(other, {number, id}) < 0)
        if (ahead.length < slots) {
          if (reported !== null) log(`[check] got a gate slot after waiting ${formatDuration(Date.now() - startedAt)}`)
          return {release}
        }
        const key = ahead.map(other => other.id).join()
        if (key !== reported) {
          log(`[check] waiting behind ${ahead.length} gate(s), at most ${slots} at a time (${SLOTS_ENV} sets the cap), for up to ${formatDuration(maxWaitMs)}:`)
          for (const other of ahead) log(`[check]   ${describeHolder(other.holder)}`)
          reported = key
        }
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        log(`[check] waited ${formatDuration(Date.now() - startedAt)} for a gate slot; running anyway`)
        release()
        return null
      }
      await sleep(choosing ? CHOOSING_RECHECK_MS : pollMs, undefined, {signal})
    }
  } catch (error) {
    release()
    if (signal?.aborted) return null
    throw error
  }
}

const git = args => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()

// Never fails the gate: a cap it cannot set up is a cap it runs without. A
// gate that dies holding a slot frees it by dying (see liveTickets).
const takeGateSlot = async signal => {
  const configured = Number(process.env[SLOTS_ENV])
  const slots = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SLOTS
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

// Why a vitest run's failures cannot all be pinned on the files it names, or
// null when they can: it finished (vitest prints the summary last), nothing
// failed outside a file, and it named every file it counted as failed.
export const unaccounted = (output, named) => {
  const summary = /^ *Test Files +(.+)$/m.exec(output)
  if (!summary) return 'the test run did not finish'
  if (/^ *Errors +\d+ errors?$/m.test(output)) return 'vitest reported unhandled errors, which belong to no file'
  const counted = Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0)
  if (counted !== named.length) return `vitest counted ${counted} failing files but named ${named.length}`
  return null
}

// `rerun` is the failing files' second run, alone. One whose failures it does
// not account for blames all of them: never claim load without a pass to show.
export const loadVerdict = (failed, rerun) => {
  const named = extractFailingFiles(rerun.output)
  const failedAlone = rerun.code === 0 ? [] : named.length && !unaccounted(rerun.output, named) ? named : failed
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
  const output = outputText(result)
  const failed = extractFailingFiles(output)
  const noVerdict = unaccounted(output, failed)
    ?? (failed.length === 0 ? 'the test task named no failing file' : null)
    ?? (failed.length > RERUN_MAX_FILES ? `${failed.length} test files failed, too many to re-run alone` : null)
  if (noVerdict) {
    console.log(`[check] no verdict: ${noVerdict}`)
    return
  }
  const rerun = await runTask({name: 'test (failing files, alone)', args: [...testTask.args, '--no-file-parallelism', ...failed]})
  if (rerun.canceled) return
  // Other gates may still be running, so the verdict says what load it ran under.
  const load = `re-run at load average ${loadavg()[0].toFixed(1)} on ${availableParallelism()} cores`
  console.log(`[check] verdict: ${loadVerdict(failed, {code: rerun.code, output: outputText(rerun)})} (${load})`)
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
  // the verdict even though the pipe hides the exit status. Only once stderr
  // has drained, since in a `2>&1` pipe a backlog there would land after it;
  // and decided after that wait, so a signal during it is in the verdict.
  const finish = async (failures = []) => {
    await new Promise(resolve => process.stderr.write('', resolve))
    const passed = failures.length === 0 && !signal.aborted
    const failed = signal.aborted ? 'interrupted' : failures.map(result => result.task.name).join(', ')
    console.log(`[check] load average ${loadAtStart.toFixed(1)} at start, ${loadavg()[0].toFixed(1)} at end, on ${availableParallelism()} cores`)
    console.log(`[check] ${passed ? 'passed' : 'failed'} in ${formatDuration(performance.now() - startedAt)}`)
    console.log(passed ? 'check: PASS' : `check: FAIL (${failed})`)
    return passed ? 0 : failures[0]?.code ?? 1
  }

  for (const task of [installTask, compileTask]) {
    const result = await runTask(task)
    // A task can outlive the signal and exit 0, and the gate must stop anyway.
    if (result.code !== 0 || signal.aborted) return finish([result])
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
  // Every time, not once: under `pnpm run check` a signal to the process group
  // arrives twice, pnpm forwarding its copy, and the second must not kill the
  // gate before it releases its ticket and prints its last line.
  process.on('SIGINT', () => abortFromSignal('SIGINT'))
  process.on('SIGTERM', () => abortFromSignal('SIGTERM'))

  const code = await runGate(abort.signal)
  // A signal already set 130/143 in abortFromSignal; keep it.
  if (code !== 0 && !abort.signal.aborted) process.exitCode = code
}

if (isMainModule(import.meta.url)) await main()
