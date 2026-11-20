#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main-module.mjs'

const PROBE_TIMEOUT = 1_000
const SYNC_SCRIPT = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

/**
 * Resolve the main repository from any checkout. The sync owns its DB and
 * locking policy; this probe only chooses the shared log location.
 */
export const resolveMainRepoRoot = ({ cwd = process.cwd() } = {}) => {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT,
    })
    if (result?.error || result?.status !== 0) return null
    const commonDir = String(result.stdout ?? '').trim()
    return commonDir ? dirname(resolve(commonDir)) : null
  } catch {
    return null
  }
}

export const syncLogPath = root => join(root, '.beads', 'codex-sync.log')

const errorMessage = error => (error instanceof Error ? error.message : String(error))

/**
 * Start the full SessionEnd sync and return without waiting for it. The sync
 * process owns DB initialization, token checks, and cross-session locking.
 * Numeric stdio descriptors avoid pipe handles in this short-lived launcher.
 */
export const launchSessionEndSync = ({
  cwd = process.cwd(),
  syncScript = SYNC_SCRIPT,
  spawnImpl = spawn,
} = {}) => {
  let root
  let logPath
  let logFd

  try {
    root = resolveMainRepoRoot({ cwd })
    if (!root) throw new Error(`could not resolve the main Git repository from ${cwd}`)

    logPath = syncLogPath(root)
    mkdirSync(dirname(logPath), { recursive: true })
    logFd = openSync(logPath, 'a')
    appendFileSync(logPath, `\n[${new Date().toISOString()}] bd-codex-session-end: starting bd-github-sync --quiet\n`)

    const child = spawnImpl(process.execPath, [syncScript, '--quiet'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })

    // A spawn error can happen after spawn() returns. Keep it visible in both
    // the local log and the hook's stderr while still allowing normal launch
    // completion to return immediately.
    child.once?.('error', error => {
      const message = `bd-codex-session-end: detached sync failed to start — ${errorMessage(error)}\n`
      try {
        appendFileSync(logPath, message)
      } catch {}
      console.error(message.trim())
    })
    child.unref()
    return { started: true, root, logPath }
  } catch (error) {
    const message = `bd-codex-session-end: failed — ${errorMessage(error)}`
    console.error(message)
    if (logPath) {
      try { appendFileSync(logPath, `${message}\n`) } catch {}
    }
    return { started: false, root: root ?? null, logPath: logPath ?? null, error: message }
  } finally {
    if (logFd !== undefined) closeSync(logFd)
  }
}

if (isMainModule(import.meta.url)) {
  const result = launchSessionEndSync()
  if (!result.started) process.exitCode = 1
}
