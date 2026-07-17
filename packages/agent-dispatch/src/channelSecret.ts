/**
 * Shared secret for the experimental channel listener. The daemon and
 * the dispatch channel MCP server (spawned by a different process)
 * can't share memory, so the secret lives in a 0600 file next to the
 * other agent-runtime credentials. Without it, the loopback listener
 * would accept prompt injections from any local process — or from a
 * browser page firing no-preflight POSTs at 127.0.0.1.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentRuntimeConfigDir, isErrnoException } from '@knowledge-medium/agent-cli/config'
import { createFileExclusive } from './atomicFile.js'

export const CHANNEL_SECRET_HEADER = 'x-km-channel-secret'
export const CHANNEL_PORT_ENV = 'KM_AGENT_DISPATCH_CHANNEL_PORT'

const channelSecretPath = () =>
  path.join(agentRuntimeConfigDir(), 'agent-dispatch-channel.secret')

/** How long a reclaim gate may be held before it's presumed crashed mid-
 *  reclaim and cleared; the gated section is a read + rm + create, so a hold
 *  longer than this means the holder is gone, not slow. */
const GATE_STALE_MS = 10_000

const newSecret = () => randomBytes(32).toString('hex')

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const readSecretAt = async (file: string): Promise<string> => {
  try {
    return (await fs.readFile(file, 'utf8')).trim()
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return ''
    throw error
  }
}

export const loadOrCreateChannelSecret = async (): Promise<string> => {
  const file = channelSecretPath()
  await fs.mkdir(path.dirname(file), {recursive: true})

  // The daemon and the ambient MCP server can first-create concurrently, in
  // separate processes with no shared memory — so creation must be atomic:
  // exactly one write wins and every loser re-reads the winner's value, or a
  // process ends up holding a secret the file no longer contains (channel 401s
  // until restart). `createFileExclusive` gives that (see atomicFile.ts): it
  // never leaves an empty file and never deletes, so concurrent creators always
  // converge on one winner.
  //
  // A file that reads back EMPTY is therefore genuine corruption, not a
  // transient create window — an old/truncated file, never something we just
  // made. Reclaiming it means delete + recreate, a non-atomic REPLACE that two
  // processes can't race without diverging (one deletes the other's fresh
  // secret from a stale "empty" read). So the reclaim — and only the reclaim —
  // is serialized behind an exclusive `mkdir` gate, the same shape pidfile.ts
  // uses to serialize its stale-pid takeover.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await readSecretAt(file)
    if (existing) return existing

    // No usable secret. Create it if absent — atomic, so this can't delete a
    // rival's work and concurrent creators converge.
    const secret = newSecret()
    if (await createFileExclusive(file, `${secret}\n`, {mode: 0o600})) return secret

    // Create lost: a file exists but was empty when we read it. Either a winner
    // has since written a real secret (re-read returns it) or a corrupt empty
    // file is blocking creation — reclaim that under the gate, then loop.
    if (await readSecretAt(file)) continue
    await reclaimEmptyFile(file, attempt)
  }
  throw new Error('Could not create or read the channel secret (persistent race or empty file).')
}

/**
 * Reclaim a corrupt (empty) secret file: delete and recreate it, serialized
 * behind an exclusive gate so concurrent reclaimers can't delete each other's
 * freshly written secret. The caller re-reads on its next loop iteration, so
 * this returns nothing — its only job is to move the file from empty to either
 * absent or holding a real secret without a destructive race.
 */
const reclaimEmptyFile = async (file: string, attempt: number): Promise<void> => {
  const gate = `${file}.reclaim`
  try {
    await fs.mkdir(gate)
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
    // Another process holds the gate. If it crashed mid-reclaim the dir would
    // wedge every later start, so clear a stale one; otherwise back off briefly
    // and let the caller loop to read the winner's result (a live holder's
    // section is sub-millisecond, so this spacing keeps us from burning the
    // whole attempt budget in a tight spin before it finishes).
    const stat = await fs.stat(gate).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs > GATE_STALE_MS) {
      await fs.rm(gate, {recursive: true, force: true}).catch(() => {})
    } else {
      await delay(15 * (attempt + 1))
    }
    return
  }
  try {
    // Re-verify emptiness UNDER the gate — another reclaimer may have healed it
    // between our read and our lock.
    if (await readSecretAt(file)) return
    await fs.rm(file, {force: true})
    await createFileExclusive(file, `${newSecret()}\n`, {mode: 0o600})
  } finally {
    await fs.rmdir(gate).catch(() => {})
  }
}
