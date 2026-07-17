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

export const CHANNEL_SECRET_HEADER = 'x-km-channel-secret'
export const CHANNEL_PORT_ENV = 'KM_AGENT_DISPATCH_CHANNEL_PORT'

const channelSecretPath = () =>
  path.join(agentRuntimeConfigDir(), 'agent-dispatch-channel.secret')

export const loadOrCreateChannelSecret = async (): Promise<string> => {
  const file = channelSecretPath()
  const dir = path.dirname(file)
  // The daemon and the ambient MCP server can first-create concurrently, in
  // separate processes with no shared memory — so creation must be atomic:
  // exactly one write wins and every loser re-reads the winner's value, or a
  // process ends up holding a secret the file no longer contains (channel 401s
  // until restart).
  //
  // We get that by writing the fully-formed secret to a PRIVATE temp file and
  // then `fs.link`-ing it into place. `link` is the atomic create-if-absent
  // primitive: it fails EEXIST if a winner already exists, and — crucially —
  // the destination only ever springs into existence already-complete. A
  // concurrent reader therefore sees no-file (ENOENT) or the full secret, never
  // an empty file. `writeFile(…, {flag:'wx'})` could not offer that: it creates
  // the target empty and fills it in a SECOND step, opening a window in which a
  // reader observes the empty file and (below) `rm`s it out from under the
  // winner mid-write, cascading into create-race churn. With that window gone,
  // the only way `file` is ever empty is genuine corruption (a truncated/old
  // file), so the empty-read `rm` here can no longer delete a live writer's
  // work — it only reclaims a dead file. A few extra attempts let that reclaim
  // heal; the healthy race resolves in at most two (lose the link → read the
  // winner, whose file is already complete).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const existing = (await fs.readFile(file, 'utf8')).trim()
      if (existing) return existing
      await fs.rm(file, {force: true}) // genuinely empty/corrupt — recreate below
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    }

    const secret = randomBytes(32).toString('hex')
    await fs.mkdir(dir, {recursive: true})
    const tmp = path.join(dir, `.channel-secret.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.writeFile(tmp, `${secret}\n`, {mode: 0o600})
      await fs.link(tmp, file) // atomic create-if-absent; EEXIST ⇒ lost the race
      return secret
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
      // lost the create race — loop once more and read the winner
    } finally {
      await fs.rm(tmp, {force: true}) // link shares the inode; drop our temp name
    }
  }
  throw new Error('Could not create or read the channel secret (persistent race or empty file).')
}
