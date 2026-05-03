import type { AppEffectCleanup } from '@/extensions/core.ts'
import { agentTokenStore, agentTokensChangedEvent } from './tokens.ts'
import { createAgentRuntimeContext, executeCommand } from './commands.ts'
import { serializeError, serializeValue } from './serialization.ts'
import type { AgentRuntimeBridgeOptions, AgentRuntimeCommand } from './protocol.ts'

const defaultBridgeUrl = 'http://127.0.0.1:8787'
const longPollMs = 25_000
const retryBaseMs = 1_000
const retryMaxMs = 30_000
const maxFastAttemptsBeforeQuiet = 6
const quietRetryMs = 60_000

export const agentRuntimeBridgeRestartEvent = 'agent-runtime-bridge:restart'

let bridgeClientId: string | null = null

const getBridgeClientId = () => {
  bridgeClientId ??= crypto.randomUUID()
  return bridgeClientId
}

const bridgeUrl = () =>
  (import.meta.env.VITE_AGENT_RUNTIME_URL?.trim() || defaultBridgeUrl).replace(/\/+$/, '')

const postJson = async (
  url: string,
  body: unknown,
  signal?: AbortSignal,
) => {
  const response = await window.fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Agent runtime bridge request failed: ${response.status}`)
  }

  return response
}

export const startAgentRuntimeBridge = (
  options: AgentRuntimeBridgeOptions,
): AppEffectCleanup => {
  const abortController = new AbortController()
  const baseUrl = bridgeUrl()
  const clientId = getBridgeClientId()
  let retryMs = retryBaseMs
  let attempts = 0
  let wakeResolve: (() => void) | null = null
  let bridgeUnavailableLogged = false
  let tokensDirty = false

  const waitForWakeOrTimeout = (ms: number) => new Promise<void>(resolve => {
    let settled = false
    let timeout: number | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      if (wakeResolve === finish) wakeResolve = null
      resolve()
    }

    timeout = window.setTimeout(finish, ms)
    wakeResolve = finish
  })

  const wakeBridgeLoop = (markTokensDirty = false) => {
    attempts = 0
    retryMs = retryBaseMs
    if (markTokensDirty) tokensDirty = true
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }

  const register = () => {
    const {repo, safeMode} = options
    const userId = repo.user.id
    const workspaceId = repo.activeWorkspaceId
    const tokens = userId && workspaceId
      ? agentTokenStore.list(userId, workspaceId).map(t => ({
          token: t.token,
          label: t.label,
          userId,
          workspaceId,
        }))
      : []

    tokensDirty = false

    return postJson(`${baseUrl}/runtime/clients/${clientId}`, {
      activeWorkspaceId: workspaceId,
      currentUser: repo.user,
      safeMode,
      href: window.location.href,
      userAgent: window.navigator.userAgent,
      audience: { userId, workspaceId },
      tokens,
    }, abortController.signal)
  }

  const reportResult = async (commandId: string, payload: unknown) => {
    await postJson(
      `${baseUrl}/runtime/commands/${commandId}/result`,
      payload,
      abortController.signal,
    )
  }

  const handleRestart = () => {
    wakeBridgeLoop(true)
  }

  const handleTokensChanged = () => {
    tokensDirty = true
    wakeBridgeLoop()
    register().catch(() => { /* loop will retry */ })
  }

  const handleVisibilityChanged = () => {
    if (document.visibilityState === 'visible') wakeBridgeLoop()
  }

  const handleWakeEvent = () => {
    wakeBridgeLoop()
  }

  window.addEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
  window.addEventListener(agentTokensChangedEvent, handleTokensChanged)
  window.addEventListener('focus', handleWakeEvent)
  window.addEventListener('online', handleWakeEvent)
  document.addEventListener('visibilitychange', handleVisibilityChanged)

  const poll = async () => {
    while (!abortController.signal.aborted) {
      try {
        if (tokensDirty) tokensDirty = false
        await register()

        if (bridgeUnavailableLogged) {
          console.info(`Agent runtime bridge reconnected at ${baseUrl}.`)
          bridgeUnavailableLogged = false
        }

        const nextUrl = new URL(`${baseUrl}/runtime/commands/next`)
        nextUrl.searchParams.set('clientId', clientId)
        nextUrl.searchParams.set('timeoutMs', String(longPollMs))

        const response = await window.fetch(nextUrl, {signal: abortController.signal})
        if (!response.ok) {
          throw new Error(`Agent runtime bridge poll failed: ${response.status}`)
        }

        const command = await response.json() as AgentRuntimeCommand | null
        retryMs = retryBaseMs
        attempts = 0

        if (!command) continue

        try {
          const value = await executeCommand(command, createAgentRuntimeContext(options))
          await reportResult(command.commandId, {
            ok: true,
            value: serializeValue(value),
          })
        } catch (error) {
          await reportResult(command.commandId, {
            ok: false,
            error: serializeError(error),
          })
        }
      } catch {
        if (abortController.signal.aborted) return

        attempts += 1
        if (attempts >= maxFastAttemptsBeforeQuiet) {
          if (!bridgeUnavailableLogged) {
            console.info(
              `Agent runtime bridge unavailable at ${baseUrl}; ` +
              `retrying quietly every ${quietRetryMs / 1000} seconds.`,
            )
            bridgeUnavailableLogged = true
          }
          await waitForWakeOrTimeout(quietRetryMs)
          if (abortController.signal.aborted) return
          continue
        }

        await waitForWakeOrTimeout(retryMs)
        if (abortController.signal.aborted) return
        retryMs = Math.min(retryMs * 2, retryMaxMs)
      }
    }
  }

  void poll()

  return () => {
    abortController.abort()
    window.removeEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
    window.removeEventListener(agentTokensChangedEvent, handleTokensChanged)
    window.removeEventListener('focus', handleWakeEvent)
    window.removeEventListener('online', handleWakeEvent)
    document.removeEventListener('visibilitychange', handleVisibilityChanged)
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }
}
