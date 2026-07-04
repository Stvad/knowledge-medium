/**
 * Programmatic bridge client — the token store + authed command runner
 * that used to live inline in cli.ts, extracted so other Node processes
 * (the claude-tasks daemon, the km MCP server, scripts) can drive the
 * bridge without shelling out to `kmagent`.
 *
 * cli.ts remains the interactive surface (pairing, printing, bridge
 * auto-start); everything here is side-effect-free library code.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bridgeLogPath,
  bridgeSecret as resolveBridgeSecret,
  bridgeUrl as resolveBridgeUrl,
  isErrnoException,
  tokenStorePath as resolveTokenStorePath,
} from './config.js'
import {
  type CommandResult,
  type CommandStatusResponse,
  type EventsNextResponse,
  type KnownCommand,
  type WhoamiInfo,
} from './protocol.js'

export const defaultProfileName = 'default'

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

// ----- Token store ---------------------------------------------------

export interface TokenRecord {
  token: string
  savedAt?: number
}

export interface TokenStore {
  profiles: Record<string, TokenRecord>
}

export const normalizeProfileName = (value = ''): string => {
  const name = value.trim()
  if (!name) return defaultProfileName
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Profile names may only contain letters, numbers, underscores, dots, and dashes.')
  }
  return name
}

const normalizeTokenRecord = (value: unknown): TokenRecord | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as {token?: unknown, savedAt?: unknown}
  if (typeof candidate.token !== 'string') return null
  return {
    token: candidate.token,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : undefined,
  }
}

export const normalizeTokenStore = (value: unknown): TokenStore => {
  const profiles: Record<string, TokenRecord> = {}

  if (value && typeof value === 'object') {
    // Legacy single-token file ({token, savedAt} at the top level) reads
    // as the default profile.
    const legacy = normalizeTokenRecord(value)
    if (legacy) profiles[defaultProfileName] = legacy

    const candidate = value as {profiles?: unknown}
    if (candidate.profiles && typeof candidate.profiles === 'object') {
      for (const [name, record] of Object.entries(candidate.profiles as Record<string, unknown>)) {
        const profileName = normalizeProfileName(name)
        const normalized = normalizeTokenRecord(record)
        if (normalized) profiles[profileName] = normalized
      }
    }
  }

  return {profiles}
}

export const loadTokenStore = async (): Promise<TokenStore> => {
  try {
    const raw = await fs.readFile(resolveTokenStorePath(), 'utf8')
    return normalizeTokenStore(JSON.parse(raw))
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {profiles: {}}
    throw error
  }
}

export const writeTokenStore = async (store: TokenStore): Promise<void> => {
  const storePath = resolveTokenStorePath()
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).sort(([a], [b]) => a.localeCompare(b)),
  )
  await fs.mkdir(path.dirname(storePath), {recursive: true})
  await fs.writeFile(
    storePath,
    `${JSON.stringify({profiles}, null, 2)}\n`,
    {mode: 0o600},
  )
}

export const loadStoredToken = async (profileName = defaultProfileName): Promise<string | null> => {
  const store = await loadTokenStore()
  return store.profiles[profileName]?.token ?? null
}

export const writeStoredToken = async (token: string, profileName = defaultProfileName): Promise<void> => {
  const store = await loadTokenStore()
  store.profiles[profileName] = {token, savedAt: Date.now()}
  await writeTokenStore(store)
}

export const removeStoredToken = async (profileName = defaultProfileName): Promise<boolean> => {
  const store = await loadTokenStore()
  if (!store.profiles[profileName]) return false
  delete store.profiles[profileName]
  if (Object.keys(store.profiles).length > 0) {
    await writeTokenStore(store)
    return true
  }

  try {
    await fs.unlink(resolveTokenStorePath())
    return true
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    return false
  }
}

export const listStoredProfiles = async (selectedProfileName = defaultProfileName) => {
  const store = await loadTokenStore()
  return Object.entries(store.profiles)
    .map(([name, record]) => ({
      name,
      savedAt: record.savedAt ?? null,
      selected: name === selectedProfileName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** AGENT_RUNTIME_TOKEN wins over the stored profile token — one-shot
 *  invocations can bypass the store entirely. */
export const resolveToken = async (profileName = defaultProfileName): Promise<string | null> => {
  const fromEnv = process.env.AGENT_RUNTIME_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return loadStoredToken(profileName)
}

// ----- HTTP plumbing -------------------------------------------------

/** Subset of fetch's `RequestInit` we use. Typed narrowly so the
 *  helpers below stay free of `any`s. */
export interface RequestOptions {
  method?: string
  body?: string
  headers?: Record<string, string>
  /** Cancels the underlying fetch — long-polls must not outlive their caller. */
  signal?: AbortSignal
}

export const requestJson = async <T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...(options.headers ?? {}),
    },
  })

  const text = await response.text()
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}`)
  }

  return body as T
}

// Errors the server returns when the client has temporarily lost its
// token registration (typical after a `yarn agent reload` or after
// `install-extension` triggers refreshAppRuntime). Retrying on these
// for ~10–15s smooths over the reconnect gap without papering over
// real auth failures (scope mismatch, missing token, etc.).
export const isTransientTokenError = (error: unknown): boolean => {
  const message = errorMessage(error)
  return message.includes('Unknown or expired token')
    || message.includes('Missing or invalid command status credentials')
}

const authedRetryTotalMs = 15_000
const authedRetryStartDelayMs = 200
const authedRetryMaxDelayMs = 1_000

/** Spawn the bridge server detached, logging to the shared bridge log.
 *  Pre-creates the bridge secret so the server and later pairing agree
 *  on it. Shared by the CLI's ensureBridgeRunning and the claude-tasks
 *  daemon's unattended preflight (which must survive reboots without a
 *  human running `yarn agent`). */
export const startBridgeInBackground = async (): Promise<void> => {
  const serverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js')
  const logPath = bridgeLogPath()
  await resolveBridgeSecret()
  await fs.mkdir(path.dirname(logPath), {recursive: true})
  const logFile = await fs.open(logPath, 'a')

  try {
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFile.fd, logFile.fd],
    })
    child.unref()
  } finally {
    await logFile.close()
  }
}

// ----- Bridge client -------------------------------------------------

export interface BridgeClientOptions {
  /** Bridge base URL; defaults to config resolution (env/loopback). */
  bridgeUrl?: string
  /** Token profile to read from the store (ignored when `token` set). */
  profile?: string
  /** Explicit bearer token, bypassing the store. */
  token?: string
  /** Default per-command completion timeout. */
  timeoutMs?: number
  /** Poll cadence while waiting for a command result. */
  pollIntervalMs?: number
}

export interface BridgeClient {
  readonly bridgeUrl: string
  /** Submit a wire command and wait for its unwrapped result value. */
  runCommand: (command: KnownCommand, options?: {timeoutMs?: number}) => Promise<unknown>
  /** Long-poll the token-audience event stream (tab-pushed events, e.g.
   *  watch-events hits). Omit `afterSeq` to bootstrap a cursor without
   *  replaying the buffer; a `reset: true` response means the bridge
   *  restarted — adopt `nextSeq` and assume missed events. */
  nextEvents: (options?: {afterSeq?: number | null, timeoutMs?: number, signal?: AbortSignal}) => Promise<EventsNextResponse>
  /** Resolve the token's audience + live-tab connection state. */
  whoami: () => Promise<WhoamiInfo>
  /** Throws unless the bridge process is reachable. */
  health: () => Promise<void>
  /** The token this client resolves to (null when unpaired). */
  resolveToken: () => Promise<string | null>
}

export const createBridgeClient = (options: BridgeClientOptions = {}): BridgeClient => {
  const bridgeUrl = (options.bridgeUrl ?? resolveBridgeUrl()).replace(/\/+$/, '')
  // AGENT_RUNTIME_PROFILE is the documented shell default; non-CLI
  // consumers (daemon, MCP server) must honor it too, not just cli.ts.
  const profileName = normalizeProfileName(options.profile ?? process.env.AGENT_RUNTIME_PROFILE ?? '')
  const defaultTimeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 100

  const clientResolveToken = async (): Promise<string | null> => {
    if (options.token) return options.token
    return resolveToken(profileName)
  }

  const requireToken = async (): Promise<string> => {
    const token = await clientResolveToken()
    if (!token) {
      throw new Error(
        `No agent token configured for profile "${profileName}". Run \`yarn agent --profile ${profileName} connect\` to pair the CLI with the app.`,
      )
    }
    return token
  }

  const authedRequest = async <T = unknown>(
    url: string,
    requestOptions: RequestOptions = {},
  ): Promise<T> => {
    const token = await requireToken()

    const send = (): Promise<T> => requestJson<T>(url, {
      ...requestOptions,
      headers: {
        ...(requestOptions.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
    })

    const start = Date.now()
    let delay = authedRetryStartDelayMs
    while (true) {
      try {
        return await send()
      } catch (error) {
        if (!isTransientTokenError(error) || Date.now() - start >= authedRetryTotalMs) {
          throw error
        }
        await sleep(delay)
        delay = Math.min(Math.round(delay * 1.5), authedRetryMaxDelayMs)
      }
    }
  }

  const submitCommand = async (command: KnownCommand): Promise<string> => {
    const response = await authedRequest<{id: string}>(`${bridgeUrl}/runtime/commands`, {
      method: 'POST',
      body: JSON.stringify(command),
    })

    return response.id
  }

  const waitForCommand = async (
    id: string,
    timeoutMs = defaultTimeoutMs,
  ): Promise<CommandResult> => {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const command = await authedRequest<CommandStatusResponse>(`${bridgeUrl}/runtime/commands/${id}`)
      if (command.status === 'completed') {
        return command.result
      }
      if (command.status === 'failed') {
        const error = command.result?.error
        throw new Error(error?.message ?? `Runtime command ${id} failed`)
      }

      await sleep(pollIntervalMs)
    }

    throw new Error(`Timed out waiting for runtime command ${id}`)
  }

  const runCommand = async (
    command: KnownCommand,
    runOptions: {timeoutMs?: number} = {},
  ): Promise<unknown> => {
    const id = await submitCommand(command)
    const result = await waitForCommand(id, runOptions.timeoutMs)

    if (!result?.ok) {
      const error = result?.error
      throw new Error(error?.message ?? 'Runtime command failed')
    }

    return result.value
  }

  const nextEvents = async (
    eventOptions: {afterSeq?: number | null, timeoutMs?: number, signal?: AbortSignal} = {},
  ): Promise<EventsNextResponse> => {
    const url = new URL(`${bridgeUrl}/runtime/events/next`)
    if (typeof eventOptions.afterSeq === 'number') {
      url.searchParams.set('afterSeq', String(eventOptions.afterSeq))
    }
    if (typeof eventOptions.timeoutMs === 'number') {
      url.searchParams.set('timeoutMs', String(eventOptions.timeoutMs))
    }
    return authedRequest<EventsNextResponse>(url.toString(), {signal: eventOptions.signal})
  }

  const whoami = async (): Promise<WhoamiInfo> => {
    const token = await requireToken()
    return requestJson<WhoamiInfo>(`${bridgeUrl}/runtime/whoami`, {
      headers: {authorization: `Bearer ${token}`},
    })
  }

  const health = async (): Promise<void> => {
    const response = await fetch(`${bridgeUrl}/health`)
    if (!response.ok) {
      throw new Error(`Bridge health check failed with status ${response.status}`)
    }
  }

  return {
    bridgeUrl,
    runCommand,
    nextEvents,
    whoami,
    health,
    resolveToken: clientResolveToken,
  }
}
