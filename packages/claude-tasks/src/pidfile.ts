/**
 * Single-instance lock. The claim protocol has no cross-process
 * atomicity (plain update-block writes), so two daemons on one machine
 * (launchd + a manual run) would double-claim and double-bill. A
 * pidfile makes that impossible here; one-daemon-per-FLEET is a
 * documented constraint (see README).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

const defaultIsAlive = (pid: number): boolean => {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = alive but not ours to signal; ESRCH = gone.
    return isErrnoException(error) && error.code === 'EPERM'
  }
}

export interface PidfileArgs {
  file: string
  pid?: number
  /** Injectable for tests — liveness of a pid read from the file. */
  isAlive?: (pid: number) => boolean
}

const readPid = async (file: string): Promise<number> =>
  Number((await fs.readFile(file, 'utf8').catch(() => '')).trim())

/** How old a takeover gate may be before it's presumed crashed-mid-
 *  takeover and cleared (the gated section contains no slow work). */
const GATE_STALE_MS = 10_000

export const acquirePidfile = async ({file, pid = process.pid, isAlive = defaultIsAlive}: PidfileArgs): Promise<void> => {
  await fs.mkdir(path.dirname(file), {recursive: true})

  // `wx` is the atomic create — no read-check-write TOCTOU where two
  // daemons starting at once both pass. On EEXIST, judge the existing
  // pid; a stale one is taken over under an exclusive gate and retried.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(file, `${pid}\n`, {flag: 'wx'})
      return
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
    }

    const existing = await readPid(file)
    if (existing && isAlive(existing) && existing !== pid) {
      throw new Error(`Another km-claude-daemon is already running (pid ${existing}). Stop it first — two daemons double-claim tasks.`)
    }

    // Stale takeover must be EXCLUSIVE: without a gate, two starters can
    // both judge the same dead pid stale, one deletes and re-creates,
    // and the other's delete then lands on the winner's FRESH pidfile —
    // admitting both daemons. mkdir is the atomic test-and-set; the
    // loser loops and re-judges against whatever the winner wrote.
    const gate = `${file}.takeover`
    try {
      await fs.mkdir(gate)
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
      // Someone else holds the gate. If its holder crashed mid-takeover
      // the dir would wedge every later start — clear it once it's old.
      const stat = await fs.stat(gate).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > GATE_STALE_MS) {
        await fs.rm(gate, {recursive: true, force: true}).catch(() => {})
      }
      continue
    }
    try {
      // Re-judge under the gate — the file may have changed hands while
      // we were acquiring it.
      const recheck = await readPid(file)
      if (recheck && isAlive(recheck) && recheck !== pid) {
        throw new Error(`Another km-claude-daemon is already running (pid ${recheck}). Stop it first — two daemons double-claim tasks.`)
      }
      await fs.rm(file, {force: true})
    } finally {
      await fs.rmdir(gate).catch(() => {})
    }
  }
  throw new Error('Could not acquire the daemon pidfile (lost a startup race).')
}

export const releasePidfile = async ({file, pid = process.pid}: PidfileArgs): Promise<void> => {
  try {
    const existing = await readPid(file)
    if (existing === pid) await fs.unlink(file)
  } catch {
    // best-effort
  }
}
