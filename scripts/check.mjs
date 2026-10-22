#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { FROZEN_INSTALL_ARGS } from './ensure-deps.mjs'

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

// Returns the exit code rather than taking it: every failure path here has
// just relayed a failing task's entire output, and `process.exit()` drops what
// is still queued on a piped stdout once the writes outrun the reader, which a
// failing task's output does comfortably. Nothing is still running when any of
// these returns, so the loop drains and ends.
const runGate = async () => {
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

const code = await runGate()
// Assigned only on failure: a signal leaves through abortFromSignal, which
// already set 130/143, and cancels every task so no firstFailure is reported.
if (code !== 0) process.exitCode = code
