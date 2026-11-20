/** Local-only registry of bridge auth tokens. A token authorizes
 *  whoever holds it to drive the agent runtime bridge as this user, on
 *  this device, in any of the user's workspaces — which workspace a call
 *  acts on is a per-call parameter, not a property of the token. Stored
 *  in localStorage (device-scoped, not synced) keyed by userId.
 *
 *  Tokens are stored in the clear: the security boundary is the
 *  browser's same-origin model + the bridge listening on
 *  127.0.0.1. Anyone who can read this localStorage already has the
 *  user's session and can do anything from the running app. */
import { hex } from '@scure/base'
import { ClientLocalSettings, clientLocalSettings } from '@/utils/ClientLocalSettings.js'
import { UUID_RE_SOURCE } from '@/data/referenceBlock.js'

export interface AgentToken {
  /** Random secret. Treat as a credential. */
  token: string
  /** User-supplied label, e.g. "claude-cli" or "scripted-export". */
  label: string
  /** read-only tokens can inspect state but cannot enqueue mutations/eval. */
  scope?: AgentTokenScope
  createdAt: number
  /** Last time this token was seen in use, for the tokens dialog. Only
   *  `touch` writes it, and nothing calls `touch` yet. */
  lastSeenAt?: number | null
}

export type AgentTokenScope = 'read-write' | 'read-only'

const KEY_PREFIX = 'agent-runtime:user-tokens'
/** Where tokens lived when they were stored per (user, workspace). A prefix
 *  the per-user key cannot share, since local-only user ids are free text. */
const LEGACY_KEY_PREFIX = 'agent-runtime:tokens'

const storageKey = (userId: string) => `${KEY_PREFIX}:${encodeURIComponent(userId)}`

/** Whether a localStorage key holds agent tokens (any user, either shape). */
export const isAgentTokensStorageKey = (key: string): boolean =>
  key.startsWith(`${KEY_PREFIX}:`) || key.startsWith(`${LEGACY_KEY_PREFIX}:`)

/** Exactly `<prefix>:<userId>:<workspace uuid>`, so user `vlad` never matches
 *  the keys of user `vlad:work`. */
const isLegacyKeyOf = (userId: string, key: string): boolean => {
  const prefix = `${LEGACY_KEY_PREFIX}:${userId}:`
  return key.startsWith(prefix) && new RegExp(`^${UUID_RE_SOURCE}$`, 'i').test(key.slice(prefix.length))
}

const readTokens = (settings: ClientLocalSettings, key: string): AgentToken[] => {
  const tokens = settings.get<AgentToken[]>(key, [])
  return Array.isArray(tokens) ? tokens : []
}

const generateSecret = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return hex.encode(bytes)
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

  list(userId: string): AgentToken[] {
    if (!userId) return []
    return this.adoptPerWorkspaceTokens(userId)
  }

  create(
    userId: string,
    label: string,
    scope: AgentTokenScope = 'read-write',
  ): AgentToken {
    if (!userId) throw new Error('userId required')

    const trimmedLabel = label.trim() || 'agent'
    const tokens = this.list(userId)
    const token: AgentToken = {
      token: generateSecret(),
      label: trimmedLabel,
      scope,
      createdAt: Date.now(),
      lastSeenAt: null,
    }
    this.settings.set(storageKey(userId), [...tokens, token])
    return token
  }

  revoke(userId: string, token: string): void {
    const tokens = this.list(userId)
    const next = tokens.filter(t => t.token !== token)
    if (next.length === tokens.length) return
    if (next.length === 0) {
      this.settings.remove(storageKey(userId))
    } else {
      this.settings.set(storageKey(userId), next)
    }
  }

  touch(userId: string, token: string): void {
    const tokens = this.list(userId)
    let changed = false
    const next = tokens.map(t => {
      if (t.token !== token) return t
      changed = true
      return {...t, lastSeenAt: Date.now()}
    })
    if (changed) this.settings.set(storageKey(userId), next)
  }

  /** The user's tokens, with any still stored under the old per-(user,
   *  workspace) keys folded in. The old keys go only once the merged list
   *  reads back whole: a write that failed (a full quota) keeps them, and
   *  this read still returns every token. */
  private adoptPerWorkspaceTokens(userId: string): AgentToken[] {
    const current = readTokens(this.settings, storageKey(userId))
    const legacyKeys = this.settings.keys().filter(key => isLegacyKeyOf(userId, key))
    if (legacyKeys.length === 0) return current

    const merged = [...current]
    const known = new Set(merged.map(t => t.token))
    for (const key of legacyKeys) {
      for (const token of readTokens(this.settings, key)) {
        if (known.has(token.token)) continue
        known.add(token.token)
        merged.push(token)
      }
    }
    if (merged.length > 0) this.settings.set(storageKey(userId), merged)
    const written = new Set(readTokens(this.settings, storageKey(userId)).map(t => t.token))
    if (merged.every(t => written.has(t.token))) {
      for (const key of legacyKeys) this.settings.remove(key)
    }
    return merged
  }
}

export const agentTokenStore = new AgentTokenStore()

export const agentTokensChangedEvent = 'agent-runtime-bridge:tokens-changed'

/** Notify any listeners (e.g. the bridge hook) that the persisted
 *  token set changed and registration should be re-sent. */
export const notifyAgentTokensChanged = () => {
  // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: signals the running bridge effect to re-register tokens
  window.dispatchEvent(new CustomEvent(agentTokensChangedEvent))
}
