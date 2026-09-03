#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

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

const parallelTasks = [
  {name: 'lint', args: ['run', 'lint']},
  {name: 'test', args: ['run', 'test']},
  {name: 'check:sync-config', args: ['run', 'check:sync-config']},
  {name: 'check:ambient-accessors', args: ['run', 'check:ambient-accessors']},
  {name: 'check:rpc-projections', args: ['run', 'check:rpc-projections']},
  {name: 'check:no-service-role', args: ['run', 'check:no-service-role']},
]

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

const runParallel = async tasks => {
  let firstFailure = null
  const states = tasks.map(startTask)
  await Promise.all(states.map(async state => {
    const result = await state.promise
    printResult(result)
    if (!firstFailure && !result.canceled && result.code !== 0) {
      firstFailure = result
      stopAll(state)
    }
    return result
  }))
  return {firstFailure}
}

const abortFromSignal = signal => {
  stopAll(null)
  process.exitCode = signal === 'SIGINT' ? 130 : 143
}

process.once('SIGINT', () => abortFromSignal('SIGINT'))
process.once('SIGTERM', () => abortFromSignal('SIGTERM'))

// Returns the exit code rather than calling process.exit: printResult has just
// replayed a failed task's whole buffered output, a write to a piped stdout is
// queued, and exit() drops the tail — which is how a CI failure arrives with
// vitest's file list but not its error block, the one part anyone needed (#881).
const main = async () => {
  const startedAt = performance.now()
  const installResult = await runTask(installTask)
  if (installResult.code !== 0) return installResult.code ?? 1

  const compileResult = await runTask(compileTask)
  if (compileResult.code !== 0) return compileResult.code ?? 1

  console.log(`[check] running ${parallelTasks.map(task => task.name).join(', ')} in parallel`)
  const {firstFailure} = await runParallel(parallelTasks)
  const duration = formatDuration(performance.now() - startedAt)

  if (firstFailure) {
    console.error(`[check] failed in ${duration}`)
    return firstFailure.code ?? 1
  }

  console.log(`[check] passed in ${duration}`)
  return 0
}

const code = await main()
// abortFromSignal may already have set a code; a run canceled mid-flight
// reports no failing task, so an unguarded assignment would call it a pass.
if (!process.exitCode) process.exitCode = code
