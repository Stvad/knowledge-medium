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

const readPidfile = async (file: string): Promise<{exists: boolean, pid: number}> => {
  try {
    return {exists: true, pid: Number((await fs.readFile(file, 'utf8')).trim())}
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {exists: false, pid: 0}
    throw error
  }
}

const alreadyRunning = (pid: number): Error =>
  new Error(`Another km-agent-dispatch is already running (pid ${pid}). Stop it first — two daemons double-claim tasks.`)

/** How old a takeover gate may be before it's presumed crashed-mid-
 *  takeover and cleared (the gated section contains no slow work). */
const GATE_STALE_MS = 10_000

/**
 * Acquire is built from two atomic primitives, and never unlinks the
 * pidfile — both are load-bearing for mutual exclusion:
 * - CREATE is link(tmp, file): the file appears with its full content
 *   or not at all. writeFile(wx) is create-THEN-write, and a rival
 *   reading the empty window parses pid 0 = "stale" and steals a live
 *   daemon's fresh pidfile.
 * - TAKEOVER is rename(tmp, file) under the gate: an atomic replace of
 *   content judged stale, with no absent window. The old rm-then-create
 *   takeover let a rival's ungated create land in the gap after a
 *   recheck that saw absence, where the rm then deleted the winner.
 * With no unlink in acquire, the file can only become absent via
 * releasePidfile by its live holder — so two creates can't both win,
 * and a rename can only replace the dead pid its holder just judged.
 */
export const acquirePidfile = async ({file, pid = process.pid, isAlive = defaultIsAlive}: PidfileArgs): Promise<void> => {
  await fs.mkdir(path.dirname(file), {recursive: true})
  const tmp = `${file}.${pid}.tmp`

  const createExclusive = async (): Promise<boolean> => {
    await fs.writeFile(tmp, `${pid}\n`)
    try {
      await fs.link(tmp, file)
      return true
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') return false
      throw error
    } finally {
      await fs.rm(tmp, {force: true})
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await createExclusive()) return

    const {pid: existing} = await readPidfile(file)
    if (existing && isAlive(existing) && existing !== pid) throw alreadyRunning(existing)

    // Stale takeover must be EXCLUSIVE: without a gate, two starters can
    // both judge the same dead pid stale and both replace the file, the
    // second clobbering the first — admitting both daemons. mkdir is the
    // atomic test-and-set; the loser loops and re-judges against
    // whatever the winner wrote.
    const gate = `${file}.takeover`
    try {
      await fs.mkdir(gate)
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
      // Someone else holds the gate. If its holder crashed mid-takeover
      // the dir would wedge every later start — clear it once it's old.
      // (A holder stalled past this while still alive would re-admit a
      // second gate; the gated section is a read + rename, so a 10s
      // stall there means the machine has worse problems.)
      const stat = await fs.stat(gate).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > GATE_STALE_MS) {
        await fs.rm(gate, {recursive: true, force: true}).catch(() => {})
      }
      continue
    }
    try {
      // Re-judge under the gate — the file may have changed hands while
      // we were acquiring it.
      const recheck = await readPidfile(file)
      if (recheck.pid && isAlive(recheck.pid) && recheck.pid !== pid) throw alreadyRunning(recheck.pid)
      // Vanished (holder released) — retry the exclusive create; a
      // blind rename here could clobber a rival's concurrent create.
      if (!recheck.exists) continue
      await fs.writeFile(tmp, `${pid}\n`)
      await fs.rename(tmp, file)
      return
    } finally {
      await fs.rmdir(gate).catch(() => {})
    }
  }
  throw new Error('Could not acquire the daemon pidfile (lost a startup race).')
}

export const releasePidfile = async ({file, pid = process.pid}: PidfileArgs): Promise<void> => {
  try {
    const {pid: existing} = await readPidfile(file)
    if (existing === pid) await fs.unlink(file)
  } catch {
    // best-effort
  }
}
