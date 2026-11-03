import type { AppEffectCleanup } from '@/extensions/core.js'
import { openDialog } from '@/utils/dialogs.js'
import { agentTokenStore, agentTokensChangedEvent, isAgentTokensStorageKey } from './tokens.ts'
// Pairing via the hash URL surfaces the tokens dialog. We open it
// imperatively rather than over a CustomEvent (audit B3). This pulls a
// UI component into the transport module, but it's bundle-safe: nothing
// in the agent-cli/server package imports bridge.ts, so React never
// reaches the node bundle.
import { AgentTokensDialog, type AgentTokensDialogProps } from './AgentTokensDialog.tsx'
import { BridgePairingDialog, type BridgePairingDialogProps } from './BridgePairingDialog.tsx'
import { BridgeNotPairedError, startBridgeLoop } from './bridgeLoop.ts'
import { createAgentRuntimeContext, executeCommand } from './commands.ts'
import { watchEventsRegistry } from './watchEvents.ts'
import { blockEditResumed, blockEditSettled } from '@/editor/editSettleSignal.js'
import type { AgentRuntimeBridgeOptions } from './protocol.ts'

const defaultBridgeUrl = 'http://127.0.0.1:8787'
const bridgeUrlStorageKey = 'agent-runtime:bridge-url'
const bridgeSecretStorageKey = 'agent-runtime:bridge-secret'
const focusedAtStorageKey = 'agent-runtime:focused-at'

export const agentRuntimeBridgeRestartEvent = 'agent-runtime-bridge:restart'

let bridgeClientId: string | null = null

const getBridgeClientId = () => {
  bridgeClientId ??= crypto.randomUUID()
  return bridgeClientId
}

// Mirror the bridge server's own loopback guard (server.ts
// `loopbackOriginPattern`; agent-cli `isLocalBridgeUrl`). A
// hash-supplied bridge URL is only ever honored when it targets the
// local loopback interface — anything else is a page trying to redirect
// the bridge at attacker-controlled infrastructure to steal the user's
// agent tokens and run commands as them. We can't import the agent-cli
// helper here (its module pulls in node:fs/os), so the check is inlined.
const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const isLoopbackBridgeUrl = (value: string): boolean => {
  try {
    const {protocol, hostname} = new URL(value)
    return (
      (protocol === 'http:' || protocol === 'https:')
      && loopbackHostnames.has(hostname)
    )
  } catch {
    return false
  }
}

const persistPairing = (url: string, secret: string | null) => {
  window.localStorage.setItem(bridgeUrlStorageKey, url)
  if (secret) window.localStorage.setItem(bridgeSecretStorageKey, secret)
  // Wake the (already running) bridge effect so it re-registers against
  // the freshly approved endpoint/secret. The loop reads the URL/secret
  // live, so the next iteration picks them up.
  // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: wakes the running bridge poll loop after the user approves a pairing
  window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
}

const confirmAndStorePairing = async (
  url: string,
  secret: string | null,
  openTokensDialog: boolean,
) => {
  // HARD gate: a pairing that arrived over a link is never written to
  // localStorage (and so never used to POST tokens) until the user
  // explicitly approves it here.
  const confirmed = await openDialog<boolean, BridgePairingDialogProps>(
    BridgePairingDialog,
    {url, hasSecret: Boolean(secret)},
  )
  if (!confirmed) return

  persistPairing(url, secret)

  if (openTokensDialog) {
    void openDialog<void, AgentTokensDialogProps>(AgentTokensDialog, {mode: 'pair-cli'})
  }
}

// Reads (and clears) any pairing params smuggled in the page hash.
// Loopback-validates and then gates them behind an explicit user
// confirmation before anything is persisted; non-loopback URLs are
// refused outright. Runs only from inside the bridge effect (startup +
// hashchange), never from the read paths below. Exported for tests.
export const processBridgePairingFromHash = () => {
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!rawHash) return

  const queryIndex = rawHash.indexOf('?')
  const paramSource = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash
  const params = new URLSearchParams(paramSource)
  const secret = params.get('agent-runtime-secret')?.trim() || null
  const rawUrl = params.get('agent-runtime-url')?.trim() || null
  const openTokensDialog = params.get('agent-runtime-open-tokens') === '1'
  if (!secret && !rawUrl && !openTokensDialog) return

  // Strip the credential-bearing params from the URL immediately —
  // before any async confirmation — so the secret can't linger in the
  // address bar, history, or referrer even if the pairing is declined
  // or refused.
  params.delete('agent-runtime-secret')
  params.delete('agent-runtime-url')
  params.delete('agent-runtime-open-tokens')

  const remainingParams = params.toString()
  const routeHash = queryIndex >= 0 ? rawHash.slice(0, queryIndex) : ''
  const nextHash = routeHash || remainingParams
    ? `#${routeHash}${remainingParams ? `?${remainingParams}` : ''}`
    : ''

  window.history.replaceState(
    null,
    document.title,
    `${window.location.pathname}${window.location.search}${nextHash}`,
  )

  const candidateUrl = rawUrl ? rawUrl.replace(/\/+$/, '') : null
  if (candidateUrl && !isLoopbackBridgeUrl(candidateUrl)) {
    // Attempted redirection to a non-loopback endpoint. Refuse the whole
    // pairing — never store it, never prompt the user to approve an
    // attacker-controlled URL, and drop any secret that rode along.
    console.warn(
      'Agent runtime: ignoring pairing link with a non-loopback bridge URL.',
    )
    return
  }

  if (candidateUrl) {
    // A loopback pairing. Gate it behind explicit confirmation; the
    // secret (if any) travels with the URL. Defer so we never open a
    // dialog synchronously during effect setup or a hashchange handler.
    window.setTimeout(() => {
      void confirmAndStorePairing(candidateUrl, secret, openTokensDialog)
    }, 0)
    return
  }

  if (secret) {
    // A secret with no bridge URL has no legitimate source — the CLI
    // always emits the URL alongside it (config.ts `pairingUrl`).
    // Honoring a lone secret would only let a link overwrite the user's
    // existing bridge secret (a reversible local DoS), so drop it. Fall
    // through so a co-supplied open-tokens request still works.
    console.warn(
      'Agent runtime: ignoring pairing secret supplied without a bridge URL.',
    )
  }

  if (openTokensDialog) {
    window.setTimeout(() => {
      void openDialog<void, AgentTokensDialogProps>(AgentTokensDialog, {mode: 'pair-cli'})
    }, 0)
  }
}

// No hash side effects — hash-supplied pairings are handled exclusively
// by `processBridgePairingFromHash` (gated by confirmation). The stored
// URL is still validated/self-healed on read, because a browser poisoned
// by the OLD pre-fix code can already hold a non-loopback attacker URL in
// localStorage; trusting it on upgrade would keep POSTing the user's
// tokens to the attacker. Returns the stored URL only if it's loopback;
// otherwise purges the poisoned URL (and the secret paired with it) and
// falls back to the build-time env override or the loopback default.
// Build-time env overrides are trusted and left untouched.
const readTrustedStoredBridgeUrl = (): string | null => {
  const stored = window.localStorage.getItem(bridgeUrlStorageKey)?.trim()
  if (!stored) return null
  if (isLoopbackBridgeUrl(stored)) return stored
  window.localStorage.removeItem(bridgeUrlStorageKey)
  window.localStorage.removeItem(bridgeSecretStorageKey)
  console.warn('Agent runtime: purged a stored non-loopback bridge URL.')
  return null
}

/** When this tab last had the user's attention. Every tab of the user holds
 *  every token, and the bridge sends a call that names no workspace to the
 *  most recently focused one. In sessionStorage so it is per tab yet survives
 *  the reloads `kmagent reload` drives. Best effort: storage that throws
 *  costs the stamp, never the registration. */
const readFocusedAt = (): number | null => {
  try {
    const stored = Number(window.sessionStorage.getItem(focusedAtStorageKey))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

const stampFocusedAt = () => {
  try {
    window.sessionStorage.setItem(focusedAtStorageKey, String(Date.now()))
  } catch {
    // See readFocusedAt.
  }
}

const getStoredBridgeSecret = () =>
  window.localStorage.getItem(bridgeSecretStorageKey)?.trim()
  || import.meta.env.VITE_AGENT_RUNTIME_BRIDGE_SECRET?.trim()
  || ''

export const bridgeUrl = () =>
  (
    readTrustedStoredBridgeUrl()
    || import.meta.env.VITE_AGENT_RUNTIME_URL?.trim()
    || defaultBridgeUrl
  ).replace(/\/+$/, '')

const bridgeHeaders = () => {
  const secret = getStoredBridgeSecret()
  if (!secret) {
    throw new BridgeNotPairedError('Agent runtime bridge is not paired. Start the bridge server and open its pairing URL.')
  }
  return {'x-agent-runtime-secret': secret}
}

export const startAgentRuntimeBridge = (
  options: AgentRuntimeBridgeOptions,
): AppEffectCleanup => {
  // Process any pairing params already present in the hash at startup.
  // Gated by user confirmation + a loopback check; nothing is persisted
  // or used here directly.
  processBridgePairingFromHash()
  if (document.hasFocus()) stampFocusedAt()

  // The bridge URL and secret are read live (see BridgeLoopOptions): a
  // link-supplied pairing only takes effect once the user confirms it, which
  // can land after the loop has started.
  const loop = startBridgeLoop({
    clientId: getBridgeClientId(),
    baseUrl: bridgeUrl,
    headers: bridgeHeaders,
    // Every token of the signed-in user, whichever workspace is open: the
    // workspace a call acts on is the call's parameter, not the token's.
    registration: () => {
      const {repo, safeMode} = options
      const userId = repo.user.id
      const workspaceId = repo.activeWorkspaceId
      return {
        activeWorkspaceId: workspaceId,
        currentUser: repo.user,
        safeMode,
        href: window.location.href,
        userAgent: window.navigator.userAgent,
        audience: {userId, workspaceId},
        focusedAt: readFocusedAt(),
        tokens: userId
          ? agentTokenStore.list(userId).map(t => ({
              token: t.token,
              label: t.label,
              scope: t.scope ?? 'read-write',
              userId,
            }))
          : [],
      }
    },
    execute: command => executeCommand(command, createAgentRuntimeContext(options)),
    // Looked up per call rather than captured, so a test's spy on it applies.
    fetch: (input, init) => window.fetch(input, init),
  })

  const reRegister = () => {
    loop.wake()
    loop.register().catch(() => { /* loop will retry */ })
  }

  // Every tab of the user registers every token, so a revoke made in another
  // tab must reach this one now, not at its next loop turn. A null key is a
  // storage clear.
  const handleStorageChanged = (event: StorageEvent) => {
    if (event.key === null || isAgentTokensStorageKey(event.key)) reRegister()
  }

  // Re-registers at once rather than at the next loop turn, so a call made
  // right after the user switches tabs already goes to the one in front.
  const handleFocused = () => {
    stampFocusedAt()
    reRegister()
  }

  const handleVisibilityChanged = () => {
    if (document.visibilityState === 'visible') handleFocused()
  }

  const handleHashChanged = () => {
    processBridgePairingFromHash()
    loop.wake()
  }

  // watch-events emissions ride this bridge connection (same secret +
  // clientId as result posts).
  watchEventsRegistry.setTransport(async event => {
    await loop.post('/runtime/events', event)
  })
  // Editor blur short-circuits the settle window for that block —
  // typed mentions fire the moment the user leaves them. Re-entering
  // the editor revokes the blur exemption (quiet is no longer
  // user-confirmed once they're back typing).
  const offEditSettled = blockEditSettled.add(blockId =>
    watchEventsRegistry.notifyBlockSettled(blockId))
  const offEditResumed = blockEditResumed.add(blockId =>
    watchEventsRegistry.notifyBlockEditing(blockId))

  window.addEventListener(agentRuntimeBridgeRestartEvent, loop.wake)
  window.addEventListener(agentTokensChangedEvent, reRegister)
  window.addEventListener('storage', handleStorageChanged)
  window.addEventListener('focus', handleFocused)
  window.addEventListener('hashchange', handleHashChanged)
  window.addEventListener('online', loop.wake)
  document.addEventListener('visibilitychange', handleVisibilityChanged)

  return () => {
    loop.stop()
    // Registrations are useless without a transport — drop them so dead
    // watchers don't keep re-running queries against a stopped bridge.
    watchEventsRegistry.setTransport(null)
    watchEventsRegistry.disposeAll()
    offEditSettled()
    offEditResumed()
    window.removeEventListener(agentRuntimeBridgeRestartEvent, loop.wake)
    window.removeEventListener(agentTokensChangedEvent, reRegister)
    window.removeEventListener('storage', handleStorageChanged)
    window.removeEventListener('focus', handleFocused)
    window.removeEventListener('hashchange', handleHashChanged)
    window.removeEventListener('online', loop.wake)
    document.removeEventListener('visibilitychange', handleVisibilityChanged)
  }
}
