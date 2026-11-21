import {randomBytes, randomUUID} from 'node:crypto'
import {bridgeSecret, bridgeUrl} from '@knowledge-medium/agent-cli/config'
import {loadStoredToken, writeStoredToken} from '@knowledge-medium/agent-cli/client'
import {startBridgeLoop, type BridgeLoopOptions} from '@/plugins/agent-runtime/bridgeLoop'
import type {User} from '@/types'
import type {HeadlessConfig} from './config'

export type HostBridge = {postEvent(event: unknown): Promise<void>, close(): Promise<void>}
export const connectBridge = async (
  config: HeadlessConfig, user: User, execute: BridgeLoopOptions['execute'],
): Promise<HostBridge> => {
  const secret = await bridgeSecret()
  let token = await loadStoredToken(config.profile)
  if (!token) {
    token = randomBytes(32).toString('hex')
    await writeStoredToken(token, config.profile)
  }
  let accepting = true
  const loop = startBridgeLoop({
    clientId: randomUUID(), baseUrl: bridgeUrl, headers: () => ({'x-agent-runtime-secret': secret}),
    registration: () => ({
      activeWorkspaceId: config.workspaceId, currentUser: user, safeMode: false,
      href: 'node:headless', userAgent: `node ${process.version}`, focusedAt: null,
      audience: {workspaceId: config.workspaceId, userId: user.id},
      tokens: accepting ? [{token, label: config.profile, scope: 'read-write', userId: user.id}] : [],
    }),
    execute,
    fetch: (url, init) => fetch(url, {...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000),
    ])}),
  })
  return {
    async postEvent(event) { await loop.post('/runtime/events', event) },
    async close() {
      accepting = false
      // Empty registration withdraws the token. An unreachable server expires
      // the client by TTL and has no explicit deregistration endpoint.
      try { await loop.register() } finally { await loop.stopAndDrain() }
    },
  }
}
