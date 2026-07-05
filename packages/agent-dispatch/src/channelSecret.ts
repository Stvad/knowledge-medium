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
  // The daemon and the ambient MCP server can first-create concurrently.
  // `wx` makes creation atomic: exactly one write wins, the loser
  // re-reads the winner's value — a plain write would leave one process
  // holding a secret the file no longer contains (channel 401s until
  // restart). Two rounds handle the read-ENOENT → lose-create race.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const existing = (await fs.readFile(file, 'utf8')).trim()
      if (existing) return existing
      await fs.rm(file, {force: true}) // corrupt/empty — recreate below
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    }

    const secret = randomBytes(32).toString('hex')
    await fs.mkdir(path.dirname(file), {recursive: true})
    try {
      await fs.writeFile(file, `${secret}\n`, {mode: 0o600, flag: 'wx'})
      return secret
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
      // lost the create race — loop once more and read the winner
    }
  }
  throw new Error('Could not create or read the channel secret (persistent race or empty file).')
}
