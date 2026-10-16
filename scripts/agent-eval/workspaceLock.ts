/**
 * `run` and `seed` mutate one shared local graph, so two of them at once
 * corrupt each other's measurements: each holds a per-workspace lock file for
 * its whole duration. A lock is stale when the pid it names is no longer alive
 * (killed or crashed holders never release); the next process takes it over.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface LockBody {
  pid: number
  since: string
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readHolder = (file: string): LockBody | undefined => {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as LockBody
    return typeof body?.pid === 'number' ? body : undefined
  } catch {
    return undefined
  }
}

const tryCreate = (file: string): boolean => {
  try {
    writeFileSync(file, JSON.stringify({pid: process.pid, since: new Date().toISOString()}), {flag: 'wx'})
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

const refuseIfAlive = (file: string) => {
  const holder = readHolder(file)
  if (holder && isAlive(holder.pid)) {
    throw new Error(`another agent-eval process (pid ${holder.pid}, since ${holder.since}) holds ${file}; wait for it to finish or stop it`)
  }
}

/** Holds `file` for this process until the returned release is called.
 *  Throws when a live process holds it; takes over a lock left by a dead one. */
export const acquireWorkspaceLock = (file: string): (() => void) => {
  mkdirSync(path.dirname(file), {recursive: true})
  if (!tryCreate(file)) {
    refuseIfAlive(file)
    try { unlinkSync(file) } catch { /* another process already took it over */ }
    if (!tryCreate(file)) {
      refuseIfAlive(file)
      throw new Error(`could not take over ${file}`)
    }
  }
  return () => {
    if (readHolder(file)?.pid !== process.pid) return
    try { unlinkSync(file) } catch { /* already gone */ }
  }
}
