/**
 * Programmatic bridge client — the token store + authed command runner
 * that used to live inline in cli.ts, extracted so other Node processes
 * (the agent-dispatch daemon, the km MCP server, scripts) can drive the
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
  UNKNOWN_TOKEN_MARKER,
  type WhoamiInfo,
} from './protocol.js'

export { UNKNOWN_TOKEN_MARKER } from './protocol.js'

export const defaultProfileName = 'default'

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The local token facts the bridge's own error cannot supply: which profiles
 * are paired on this machine, which one is selected, and whether an env token
 * is overriding the selection. Printed underneath that error.
 *
 * FACTS ONLY — no cause, no recommended remedy. Composing a diagnosis out of
 * this state is what the first version did, and every state combination is
 * another sentence that can be false: "most recently paired" over undated
 * entries ranks nothing, "the profile is not the cause" is wrong when the sole
 * saved token was revoked, and a bare `kmagent connect` re-pairs `default`
 * rather than the profile that failed. Twelve review findings, all of that
 * shape. The reader draws the conclusion from the listing in one glance; the
 * tool cannot get a fact wrong.
 *
 * `profiles: null` means the store could not be read. It is a value rather
 * than a throw because the override and the selection are true regardless —
 * letting an unreadable store suppress them lost the one piece of advice that
 * needed no store at all.
 */
export const formatTokenContext = (
  {profiles, tokenStorePath, selected, envTokenOverride}: {
    profiles: readonly {name: string; savedAt?: number | null}[] | null
    tokenStorePath: string
    selected: string
    envTokenOverride: boolean
  },
): string => {
  const lines: string[] = []
  if (profiles === null) {
    lines.push(`Token store: ${tokenStorePath} (could not be read)`)
  } else if (profiles.length === 0) {
    lines.push(`Token store: ${tokenStorePath} (no profiles saved)`)
  } else {
    lines.push(`Token store: ${tokenStorePath}`)
    const width = Math.max(...profiles.map(profile => profile.name.length))
    // Alphabetical, not by recency: the instants are printed, so ordering by
    // them would be the tool ranking candidates it has no business ranking —
    // and a name is what a reader half-remembers.
    for (const profile of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `  ${profile.name.padEnd(width)}  ${pairedAt(profile.savedAt)}`
        + (profile.name === selected ? '  ← selected' : ''),
      )
    }
  }
  lines.push(`selected profile: ${selected}`)
  if (envTokenOverride) {
    lines.push('AGENT_RUNTIME_TOKEN is set — it overrides --profile.')
  }
  return lines.join('\n')
}

/** UTC instant, not a locale rendering: this goes in error output that gets
 *  pasted into issues, and it must mean the same thing wherever it is read. */
const pairedAt = (savedAt: number | null | undefined): string =>
  typeof savedAt === 'number'
    ? `${new Date(savedAt).toISOString().slice(0, 16).replace('T', ' ')}Z`
    : '(no pairing timestamp)'

/** A non-2xx from the bridge, carrying the STATUS so callers can classify on
 *  the protocol instead of on message text. */
export class BridgeHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'BridgeHttpError'
  }
}

/** No token is configured for the selected profile — refused LOCALLY, before
 *  any request. Typed so the profile listing can attach to it as well: this is
 *  the commonest shape of the failure and it never reaches the bridge. `code`
 *  rather than `instanceof`, which does not survive a realm boundary. */
export class MissingTokenError extends Error {
  readonly code = 'missing-token'
  constructor(readonly profileName: string) {
    super(
      `No agent token configured for profile "${profileName}". `
      + `Run \`kmagent --profile ${profileName} connect\` to pair the CLI with the app.`,
    )
    this.name = 'MissingTokenError'
  }
}

/** Is this the bridge refusing an unregistered token?
 *
 *  Status AND text, because neither alone is sound: `kmagent eval` runs
 *  arbitrary code in the app and can throw a message containing the marker
 *  while auth succeeded, and 401 alone covers other refusals with their own
 *  remedies. Read `status` structurally rather than by `instanceof`, which does
 *  not survive a realm boundary (see the MCP server's worker paths). */
const isUnknownTokenError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as {status?: unknown}).status === 401
  && errorMessage(error).includes(UNKNOWN_TOKEN_MARKER)

const isMissingTokenError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as {code?: unknown}).code === 'missing-token'

/** Appends {@link formatTokenContext} to the two failures the token context can
 *  explain — the bridge's unknown-token 401 and the local missing-token refusal
 *  — and returns any other error's message untouched.
 *
 *  Fires on `kmagent connect`'s verification of a freshly pasted token too,
 *  where the store is beside the point. ACCEPTED rather than plumbed around:
 *  under facts-only that output is irrelevant, not misleading, and carrying a
 *  token-source flag through the error would re-add the branch this module was
 *  rewritten to delete. */
export const withProfileHelp = (
  error: unknown,
  help: () => Promise<string>,
): Promise<string> => {
  const message = errorMessage(error)
  return isUnknownTokenError(error) || isMissingTokenError(error)
    ? help().then(extra => `${message}\n${extra}`, () => message)
    : Promise.resolve(message)
}

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
    throw new BridgeHttpError(
      body?.error ?? `Request failed with status ${response.status}`,
      response.status,
    )
  }

  return body as T
}

// Errors the server returns when the client has temporarily lost its
// token registration (typical after a `kmagent reload` or after
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
 *  on it. Shared by the CLI's ensureBridgeRunning and the agent-dispatch
 *  daemon's unattended preflight (which must survive reboots without a
 *  human running `kmagent`). */
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
      throw new MissingTokenError(profileName)
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
