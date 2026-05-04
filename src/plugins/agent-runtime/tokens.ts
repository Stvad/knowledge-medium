/** Local-only registry of bridge auth tokens. A token authorizes
 *  whoever holds it to drive the agent runtime bridge as if they were
 *  this user, in this workspace, on this device. Stored in
 *  localStorage (device-scoped, not synced) keyed by
 *  (userId, workspaceId).
 *
 *  Tokens are stored in the clear: the security boundary is the
 *  browser's same-origin model + the bridge listening on
 *  127.0.0.1. Anyone who can read this localStorage already has the
 *  user's session and can do anything from the running app. */
import { ClientLocalSettings, clientLocalSettings } from '@/utils/ClientLocalSettings.ts'

export interface AgentToken {
  /** Random secret. Treat as a credential. */
  token: string
  /** User-supplied label, e.g. "claude-cli" or "scripted-export". */
  label: string
  /** read-only tokens can inspect state but cannot enqueue mutations/eval. */
  scope?: AgentTokenScope
  createdAt: number
  /** Last time we observed a registration with this token. Updated by
   *  the bridge handshake reply, so users can see which tokens are
   *  actively in use. */
  lastSeenAt?: number | null
}

export type AgentTokenScope = 'read-write' | 'read-only'

const KEY_PREFIX = 'agent-runtime:tokens'

const storageKey = (userId: string, workspaceId: string) =>
  `${KEY_PREFIX}:${userId}:${workspaceId}`

const generateSecret = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback for non-browser environments (tests). 32 bytes of randomness
  // from Math.random is weak but the agentTokens module is never run
  // outside the browser in production code paths.
  let result = ''
  for (let i = 0; i < 64; i += 1) {
    result += Math.floor(Math.random() * 16).toString(16)
  }
  return result
}

export class AgentTokenStore {
  constructor(private readonly settings: ClientLocalSettings = clientLocalSettings) {}

  list(userId: string, workspaceId: string): AgentToken[] {
    if (!userId || !workspaceId) return []
    const tokens = this.settings.get<AgentToken[]>(storageKey(userId, workspaceId), [])
    return Array.isArray(tokens) ? tokens : []
  }

  create(
    userId: string,
    workspaceId: string,
    label: string,
    scope: AgentTokenScope = 'read-write',
  ): AgentToken {
    if (!userId) throw new Error('userId required')
    if (!workspaceId) throw new Error('workspaceId required')

    const trimmedLabel = label.trim() || 'agent'
    const tokens = this.list(userId, workspaceId)
    const token: AgentToken = {
      token: generateSecret(),
      label: trimmedLabel,
      scope,
      createdAt: Date.now(),
      lastSeenAt: null,
    }
    this.settings.set(storageKey(userId, workspaceId), [...tokens, token])
    return token
  }

  revoke(userId: string, workspaceId: string, token: string): void {
    const tokens = this.list(userId, workspaceId)
    const next = tokens.filter(t => t.token !== token)
    if (next.length === tokens.length) return
    if (next.length === 0) {
      this.settings.remove(storageKey(userId, workspaceId))
    } else {
      this.settings.set(storageKey(userId, workspaceId), next)
    }
  }

  touch(userId: string, workspaceId: string, token: string): void {
    const tokens = this.list(userId, workspaceId)
    let changed = false
    const next = tokens.map(t => {
      if (t.token !== token) return t
      changed = true
      return {...t, lastSeenAt: Date.now()}
    })
    if (changed) this.settings.set(storageKey(userId, workspaceId), next)
  }
}

export const agentTokenStore = new AgentTokenStore()

export const agentTokensChangedEvent = 'agent-runtime-bridge:tokens-changed'

/** Notify any listeners (e.g. the bridge hook) that the persisted
 *  token set changed and registration should be re-sent. */
export const notifyAgentTokensChanged = () => {
  window.dispatchEvent(new CustomEvent(agentTokensChangedEvent))
}
