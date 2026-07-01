/**
 * Shared secret for the experimental channel listener. The daemon and
 * the km MCP server (spawned by a different process — Claude Code)
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

export const channelSecretPath = () =>
  path.join(agentRuntimeConfigDir(), 'claude-tasks-channel.secret')

export const loadOrCreateChannelSecret = async (): Promise<string> => {
  const file = channelSecretPath()
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim()
    if (existing) return existing
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
  }

  const secret = randomBytes(32).toString('hex')
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, `${secret}\n`, {mode: 0o600})
  return secret
}
