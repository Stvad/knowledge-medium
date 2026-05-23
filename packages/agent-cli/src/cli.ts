#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { cac } from 'cac'
import {
  bridgeLogPath,
  bridgeSecret as resolveBridgeSecret,
  bridgeUrl as resolveBridgeUrl,
  isLocalBridgeUrl,
  pairingUrl,
  tokenStorePath as resolveTokenStorePath,
} from './config.js'
import {
  type Audience,
  type CommandPayload,
  type CommandResult,
  type CommandStatusResponse,
  type WhoamiInfo,
} from './protocol.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverScript = path.join(here, 'server.js')
const bridgeUrl = resolveBridgeUrl()
const pollIntervalMs = 100
const defaultTimeoutMs = 30_000
const bridgeStartTimeoutMs = 5_000
const tokenStorePath = resolveTokenStorePath()
const defaultProfileName = 'default'
let selectedProfileName = defaultProfileName

// Narrow a thrown `unknown` to NodeJS fs/HTTP errors so we can check
// `.code === 'ENOENT'` etc without sprinkling `as any` everywhere.
const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface TokenRecord {
  token: string
  savedAt?: number
}

interface TokenStore {
  profiles: Record<string, TokenRecord>
}

/** Subset of fetch's `RequestInit` we use. Typed narrowly so the
 *  helpers below stay free of `any`s. */
interface RequestOptions {
  method?: string
  body?: string
  headers?: Record<string, string>
}

/** Per-client record returned by GET /health?detail=1 — typed loose
 *  (only the fields we read for the `ping` summary). */
interface BridgeStatusClient {
  id?: string
  lastSeen?: number
  tokenCount?: number
  audience?: Audience | null
  metadata?: {activeWorkspaceId?: unknown, currentUser?: unknown}
}

interface BridgeStatusResponse {
  ok?: boolean
  clients?: BridgeStatusClient[]
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const canAutoStartBridge = (): boolean =>
  !process.env.AGENT_RUNTIME_URL && isLocalBridgeUrl(bridgeUrl)

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

// cac coerces a repeated `--actions foo --actions bar` to `['foo', 'bar']`,
// but a single occurrence gives a bare string. Normalize to an array
// so the wire payload is shaped consistently regardless of how the
// user phrased it.
const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return [value]
  return []
}

const evalReturnedUndefined = (value: unknown): boolean =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as {type?: unknown}).type === 'undefined'
  && Object.keys(value as object).length === 1

// Eval handlers commonly run for side effects and don't `return` —
// surface that as a single legible token instead of `{type:
// 'undefined'}`, which is easy to mistake for an error. Same idea
// for the explicit string "undefined" some callers return from
// `repo.db.execute(...)` etc.
const formatEvalOutput = (value: unknown, raw: boolean): string => {
  if (raw) return JSON.stringify(value, null, 2)
  if (value === undefined || value === null || evalReturnedUndefined(value)) {
    return '<ok: eval completed, no return value (use `return ...` to print one; pass --raw for the wire format)>'
  }
  return JSON.stringify(value, null, 2)
}

// Accept "<id>" (UUID) or "<label>" — extensions installed via the
// bridge are tagged with their label as an alias, so a single positional
// arg can resolve to either.
const extensionHandle = (handle: string): {id: string} | {label: string} => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle)
  return isUuid ? {id: handle} : {label: handle}
}

const normalizeProfileName = (value = '') => {
  const name = value.trim()
  if (!name) return defaultProfileName
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Profile names may only contain letters, numbers, underscores, dots, and dashes.')
  }
  return name
}

selectedProfileName = normalizeProfileName(process.env.AGENT_RUNTIME_PROFILE ?? '')

const normalizeTokenRecord = (value: unknown): TokenRecord | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as {token?: unknown, savedAt?: unknown}
  if (typeof candidate.token !== 'string') return null
  return {
    token: candidate.token,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : undefined,
  }
}

const normalizeTokenStore = (value: unknown): TokenStore => {
  const profiles: Record<string, TokenRecord> = {}

  if (value && typeof value === 'object') {
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

const loadTokenStore = async (): Promise<TokenStore> => {
  try {
    const raw = await fs.readFile(tokenStorePath, 'utf8')
    return normalizeTokenStore(JSON.parse(raw))
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {profiles: {}}
    throw error
  }
}

const writeTokenStore = async (store: TokenStore): Promise<void> => {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).sort(([a], [b]) => a.localeCompare(b)),
  )
  await fs.mkdir(path.dirname(tokenStorePath), {recursive: true})
  await fs.writeFile(
    tokenStorePath,
    `${JSON.stringify({profiles}, null, 2)}\n`,
    {mode: 0o600},
  )
}

const loadStoredToken = async (profileName = selectedProfileName): Promise<string | null> => {
  const store = await loadTokenStore()
  return store.profiles[profileName]?.token ?? null
}

const writeStoredToken = async (token: string, profileName = selectedProfileName): Promise<void> => {
  const store = await loadTokenStore()
  store.profiles[profileName] = {token, savedAt: Date.now()}
  await writeTokenStore(store)
}

const removeStoredToken = async (profileName = selectedProfileName) => {
  const store = await loadTokenStore()
  if (!store.profiles[profileName]) return false
  delete store.profiles[profileName]
  if (Object.keys(store.profiles).length > 0) {
    await writeTokenStore(store)
    return true
  }

  try {
    await fs.unlink(tokenStorePath)
    return true
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    return false
  }
}

const listStoredProfiles = async () => {
  const store = await loadTokenStore()
  return Object.entries(store.profiles)
    .map(([name, record]) => ({
      name,
      savedAt: record.savedAt ?? null,
      selected: name === selectedProfileName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const resolveToken = async () => {
  const fromEnv = process.env.AGENT_RUNTIME_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return loadStoredToken()
}

const requestJson = async <T = unknown>(
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

const promptForToken = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  try {
    return (await rl.question('Paste agent token: ')).trim()
  } finally {
    rl.close()
  }
}

const fetchBridgeHealth = async () => {
  const response = await fetch(`${bridgeUrl}/health`)
  if (!response.ok) {
    throw new Error(`Bridge health check failed with status ${response.status}`)
  }
}

const waitForBridgeReady = async () => {
  const startedAt = Date.now()
  let lastError: unknown = null

  while (Date.now() - startedAt < bridgeStartTimeoutMs) {
    try {
      await fetchBridgeHealth()
      return
    } catch (error) {
      lastError = error
      await sleep(100)
    }
  }

  throw new Error(
    `Agent runtime bridge did not become ready at ${bridgeUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

const startBridgeInBackground = async () => {
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

  process.stderr.write(`Started agent runtime bridge in the background at ${bridgeUrl}. Logs: ${logPath}\n`)
}

const ensureBridgeRunning = async () => {
  try {
    await fetchBridgeHealth()
    return
  } catch (error) {
    if (!canAutoStartBridge()) {
      throw error
    }
  }

  await startBridgeInBackground()
  await waitForBridgeReady()
}

const bridgeSecretForStatus = async () => {
  const fromEnv = process.env.AGENT_RUNTIME_BRIDGE_SECRET?.trim()
  if (fromEnv) return fromEnv
  if (process.env.AGENT_RUNTIME_URL) return ''
  return resolveBridgeSecret()
}

const readBridgeStatus = async (): Promise<BridgeStatusResponse> => {
  const bridgeSecret = await bridgeSecretForStatus()
  return requestJson<BridgeStatusResponse>(`${bridgeUrl}/health${bridgeSecret ? '?detail=1' : ''}`, {
    headers: bridgeSecret ? {'x-agent-runtime-secret': bridgeSecret} : {},
  })
}

const compactUser = (user: unknown): Record<string, unknown> | null => {
  if (!user || typeof user !== 'object') return null
  const candidate = user as {id?: unknown, name?: unknown}
  const compact: Record<string, unknown> = {}
  if (typeof candidate.id === 'string') compact.id = candidate.id
  if (typeof candidate.name === 'string') compact.name = candidate.name
  return Object.keys(compact).length > 0 ? compact : null
}

const compactBridgeClient = (client: BridgeStatusClient): Record<string, unknown> => {
  const metadata: {activeWorkspaceId?: unknown, currentUser?: unknown} =
    client?.metadata && typeof client.metadata === 'object'
      ? client.metadata
      : {}
  const compact: Record<string, unknown> = {
    id: client.id,
    lastSeen: client.lastSeen,
    tokenCount: client.tokenCount,
  }

  if (client.audience) compact.audience = client.audience
  if (typeof metadata.activeWorkspaceId === 'string') compact.activeWorkspaceId = metadata.activeWorkspaceId
  const currentUser = compactUser(metadata.currentUser)
  if (currentUser) compact.currentUser = currentUser

  return compact
}

const printPing = async () => {
  await ensureBridgeRunning()
  const runtime = await runCommand({type: 'ping'}) as {ok?: unknown} | null
  const status = await readBridgeStatus()
  const bridge: Record<string, unknown> = {ok: Boolean(status?.ok)}

  if (Array.isArray(status?.clients)) {
    bridge.clients = status.clients.map(compactBridgeClient)
  }

  process.stdout.write(`${JSON.stringify({
    ok: runtime?.ok === true && bridge.ok,
    profile: selectedProfileName,
    runtime,
    bridge,
  }, null, 2)}\n`)
}

const whoamiWithToken = (token: string): Promise<WhoamiInfo> =>
  requestJson<WhoamiInfo>(`${bridgeUrl}/runtime/whoami`, {
    headers: {authorization: `Bearer ${token}`},
  })

const reloadAppAndWait = async ({timeoutMs = 30_000} = {}) => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(`No agent token configured for profile "${selectedProfileName}". Run \`yarn agent --profile ${selectedProfileName} connect\` first.`)
  }

  const before = await whoamiWithToken(token).catch(() => null)
  if (!before?.connected) {
    throw new Error('No app tab is currently connected — nothing to reload. Open the app, then retry.')
  }
  const previousClientId = before.clientId

  // Schedule the reload after a short delay so the eval result reaches
  // the bridge before the JS context is torn down. Otherwise the
  // bridge sees a delivered-but-never-completed command.
  await runCommand({
    type: 'eval',
    code: 'setTimeout(() => window.location.reload(), 100)',
  })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(250)
    const info = await whoamiWithToken(token).catch(() => null)
    if (info?.connected && info.clientId !== previousClientId) {
      return info
    }
  }
  throw new Error(`App did not reconnect within ${Math.round(timeoutMs / 1000)}s`)
}

const navigateAppHash = async (hash: string): Promise<unknown> => {
  if (typeof hash !== 'string') {
    throw new Error('navigate requires a hash string')
  }
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash
  // JSON.stringify both escapes and quotes the value safely.
  return runCommand({
    type: 'eval',
    code: `window.location.hash = ${JSON.stringify(normalized)}`,
  })
}

const waitForTokenAudience = async (token: string): Promise<WhoamiInfo> => {
  const startedAt = Date.now()
  let lastError: unknown = null

  while (Date.now() - startedAt < 10_000) {
    try {
      return await whoamiWithToken(token)
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }

  throw lastError ?? new Error('Timed out waiting for token registration')
}

const printConnectSuccess = (info: WhoamiInfo): void => {
  const audience = info.audience ?? {}
  process.stdout.write(
    `Connected. Token saved at ${tokenStorePath} (profile: ${selectedProfileName})\n` +
    `User: ${audience.userId ?? '?'}\n` +
    `Workspace: ${audience.workspaceId ?? '?'}\n` +
    `Connected client: ${info.connected ? 'yes' : 'no (will auto-connect when the app reaches the bridge)'}\n`,
  )
}

const connectWithToken = async (
  token: string,
  options: {saveBeforeVerify?: boolean} = {},
): Promise<void> => {
  const saveBeforeVerify = options.saveBeforeVerify ?? true
  if (saveBeforeVerify) await writeStoredToken(token)

  // Direct-token mode preserves the old behavior: save first, then
  // verify when the app is reachable. Interactive pairing verifies
  // first so a mistyped pasted token is not persisted.
  try {
    await ensureBridgeRunning()
    const info = await waitForTokenAudience(token)
    if (!saveBeforeVerify) await writeStoredToken(token)
    printConnectSuccess(info)
  } catch (error) {
    if (!saveBeforeVerify) throw error
    process.stdout.write(
      `Token saved at ${tokenStorePath} (profile: ${selectedProfileName}), but bridge contact failed: ${errorMessage(error)}\n` +
      `Make sure the app tab is open. Run \`yarn agent whoami\` to verify.\n`,
    )
  }
}

const describeExistingConnection = async () => {
  const token = await loadStoredToken()
  if (!token) return null

  try {
    await ensureBridgeRunning()
    return {token, info: await whoamiWithToken(token)}
  } catch {
    return {token, info: null}
  }
}

const connectInteractively = async ({force = false} = {}) => {
  if (!force) {
    const existing = await describeExistingConnection()
    if (existing?.info?.connected) {
      const audience = existing.info.audience ?? {}
      process.stdout.write(
        `Profile "${selectedProfileName}" is already paired with a connected app tab.\n` +
        `User: ${audience.userId ?? '?'}\n` +
        `Workspace: ${audience.workspaceId ?? '?'}\n` +
        `Pass --force to re-pair (revokes nothing on its own — generate a new token in the app first if you want to rotate).\n`,
      )
      return
    }
    if (existing) {
      process.stdout.write(
        `Profile "${selectedProfileName}" has a saved token but no app tab is currently connected.\n` +
        `Open or focus the app tab, or run \`yarn agent whoami\` to recheck. Re-pairing anyway…\n\n`,
      )
    }
  }

  await ensureBridgeRunning()
  const url = await pairingUrl(bridgeUrl, {openTokensDialog: true})
  process.stdout.write(
    `Open this URL in the app to pair the agent CLI:\n${url}\n\n` +
    'The app will open the token dialog. Generate a token, copy it, then paste it here.\n',
  )

  const token = await promptForToken()
  if (!token) {
    throw new Error('No token pasted; pairing was not completed.')
  }
  await connectWithToken(token, {saveBeforeVerify: false})
}

// Errors the server returns when the client has temporarily lost its
// token registration (typical after a `yarn agent reload` or after
// `install-extension` triggers refreshAppRuntime). Retrying on these
// for ~10–15s smooths over the reconnect gap without papering over
// real auth failures (scope mismatch, missing token, etc.).
const isTransientTokenError = (error: unknown): boolean => {
  const message = errorMessage(error)
  return message.includes('Unknown or expired token')
    || message.includes('Missing or invalid command status credentials')
}

const authedRetryTotalMs = 15_000
const authedRetryStartDelayMs = 200
const authedRetryMaxDelayMs = 1_000

const authedRequest = async <T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<T> => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(
      `No agent token configured for profile "${selectedProfileName}". Run \`yarn agent --profile ${selectedProfileName} connect\` to pair the CLI with the app.`,
    )
  }

  const send = (): Promise<T> => requestJson<T>(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
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

const submitCommand = async (command: CommandPayload): Promise<string> => {
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

const runCommand = async (command: CommandPayload): Promise<unknown> => {
  const id = await submitCommand(command)
  const result = await waitForCommand(id)

  if (!result?.ok) {
    const error = result?.error
    throw new Error(error?.message ?? 'Runtime command failed')
  }

  return result.value
}

/** Helper: connect to the bridge, run a wire-protocol command, and
 *  pretty-print the result. Used by the "thin" bridge-fronting commands
 *  (sql, get-block, runtime-summary, install-extension, …). */
const runAndPrint = async (command: CommandPayload): Promise<void> => {
  await ensureBridgeRunning()
  const value = await runCommand(command)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const cli = cac('kmagent')

// Global option. The catch-all `--profile <name>` selects which CLI
// token profile to use; defaults to AGENT_RUNTIME_PROFILE then to
// "default". We apply it from `cli.options.profile` after parse rather
// than inside each action so the value is consistently set before
// `ensureBridgeRunning`/token lookup runs.
cli.option('--profile, -p <name>', 'Saved CLI token profile to use')

// ----- Local / bridge-management commands ---------------------------

cli
  .command('connect [token]', 'Pair the agent CLI with the app (or save a token directly)')
  .option('--force', 'Re-pair even if an active connection already exists')
  .action(async (token: string | undefined, options: {force?: boolean}) => {
    const resolved = token?.trim() || process.env.AGENT_RUNTIME_TOKEN?.trim()
    if (resolved) {
      await connectWithToken(resolved)
    } else {
      await connectInteractively({force: Boolean(options.force)})
    }
  })

cli
  .command('disconnect', 'Remove the selected profile token')
  .action(async () => {
    const removed = await removeStoredToken()
    process.stdout.write(
      removed
        ? `Removed profile "${selectedProfileName}" from ${tokenStorePath}\n`
        : `No token profile "${selectedProfileName}" exists in ${tokenStorePath}\n`,
    )
  })

cli
  .command('remove-profile <name>', 'Remove a saved CLI token profile')
  .alias('disconnect-profile')
  .action(async (name: string) => {
    const profileName = normalizeProfileName(name)
    const removed = await removeStoredToken(profileName)
    process.stdout.write(
      removed
        ? `Removed profile "${profileName}" from ${tokenStorePath}\n`
        : `No token profile "${profileName}" exists in ${tokenStorePath}\n`,
    )
  })

cli
  .command('profiles', 'List saved CLI token profiles')
  .action(async () => {
    const profiles = await listStoredProfiles()
    process.stdout.write(`${JSON.stringify({
      tokenStorePath,
      selectedProfile: selectedProfileName,
      profiles,
    }, null, 2)}\n`)
  })

cli
  .command('pair-url', 'Print the current app pairing URL')
  .action(async () => {
    await ensureBridgeRunning()
    process.stdout.write(`${await pairingUrl()}\n`)
  })

cli
  .command('whoami', 'Show the audience the persisted token resolves to')
  .action(async () => {
    await ensureBridgeRunning()
    const token = await resolveToken()
    if (!token) {
      throw new Error(
        `No agent token configured for profile "${selectedProfileName}". `
        + `Run \`yarn agent --profile ${selectedProfileName} connect\` first.`,
      )
    }
    const info = await whoamiWithToken(token)
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
  })

cli
  .command('ping', 'Ping the bridge + runtime; print a status summary')
  .action(async () => {
    await printPing()
  })

cli
  .command('status', 'Show bridge status (clients, commands)')
  .action(async () => {
    await ensureBridgeRunning()
    const status = await readBridgeStatus()
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  })

cli
  .command('reload', 'Hard-reload the app tab and wait for it to reconnect')
  .action(async () => {
    await ensureBridgeRunning()
    const info = await reloadAppAndWait()
    process.stdout.write(`${JSON.stringify({ok: true, reconnected: info}, null, 2)}\n`)
  })

cli
  .command('navigate <hash>', 'Set window.location.hash (with or without leading #)')
  .action(async (hash: string) => {
    await ensureBridgeRunning()
    await navigateAppHash(hash)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      hash: hash.startsWith('#') ? hash : `#${hash}`,
    }, null, 2)}\n`)
  })

// ----- Bridge-fronting commands -------------------------------------

cli
  .command('runtime-summary', 'Compact agent-oriented runtime context')
  .action(async () => {
    await runAndPrint({type: 'runtime-summary'})
  })

cli
  .command('describe-runtime', 'Show full or targeted runtime diagnostics. Canonical "what is registered" view — prefer over reaching into facetRuntime/Repo internals via eval. When --guide is passed alone, defaults to brief output; pass --full to include actions/facets/modules/components too.')
  .option('--actions <text>', 'Filter actions (repeatable)')
  .option('--facets <text>', 'Filter facets (repeatable)')
  .option('--guide, --guides <id>', 'Show specific guide(s) (repeatable)')
  .option('--modules <text>', 'Filter modules (repeatable)')
  .option('--components <text>', 'Filter components (repeatable)')
  .option('--storage', 'Include storage diagnostics')
  .option('--full', 'Force full output even when --guide is set')
  .action(async (options: Record<string, unknown>) => {
    const actions = toStringArray(options.actions)
    const facets = toStringArray(options.facets)
    const guides = toStringArray(options.guide)
    const modules = toStringArray(options.modules)
    const components = toStringArray(options.components)
    const storage = Boolean(options.storage)
    const fullRequested = Boolean(options.full)

    // Brief by default whenever --guide was the agent's intent and they
    // didn't opt into other heavy sections.
    const heavyFilterPresent
      = actions.length > 0
        || facets.length > 0
        || modules.length > 0
        || components.length > 0
    const briefImplied = guides.length > 0 && !heavyFilterPresent && !fullRequested

    await runAndPrint({
      type: 'describe-runtime',
      ...(actions.length > 0 ? {actions} : {}),
      ...(facets.length > 0 ? {facets} : {}),
      ...(guides.length > 0 ? {guides} : {}),
      ...(modules.length > 0 ? {modules} : {}),
      ...(components.length > 0 ? {components} : {}),
      ...(storage ? {storage: true} : {}),
      ...(briefImplied ? {brief: true} : {}),
    })
  })

cli
  .command('sql <mode> <sql> [paramsJson]', 'Run SQL (mode: all|get|optional|execute)')
  .action(async (mode: string, sql: string, paramsJson: string | undefined) => {
    await runAndPrint({
      type: 'sql',
      mode,
      sql,
      params: paramsJson ? parseJson(paramsJson, 'paramsJson') : [],
    })
  })

cli
  .command('get-block <id>', 'Fetch a block by id')
  .action(async (id: string) => {
    await runAndPrint({type: 'get-block', id})
  })

cli
  .command('subtree <rootId>', 'Fetch the subtree rooted at <rootId>')
  .option('--include-root', 'Include the root block itself in the response')
  .action(async (rootId: string, options: {includeRoot?: boolean}) => {
    await runAndPrint({
      type: 'get-subtree',
      rootId,
      includeRoot: Boolean(options.includeRoot),
    })
  })

cli
  .command('create-block <json>', 'Create a block (body shape per <json>)')
  .action(async (json: string) => {
    const parsed = parseJson(json, 'create-block json') as Record<string, unknown>
    await runAndPrint({type: 'create-block', ...parsed})
  })

cli
  .command('update-block <json>', 'Update a block (body shape per <json>)')
  .action(async (json: string) => {
    const parsed = parseJson(json, 'update-block json') as Record<string, unknown>
    await runAndPrint({type: 'update-block', ...parsed})
  })

cli
  .command('install-extension <file> [...label]', 'Install a JS extension. Reload is automatic; --verify reports the contributed facets/actions; label defaults to the filename without ext.')
  .option('--verify', 'Verify the extension shape and report what it contributes')
  .option('--description <text>', 'Human-readable description')
  .action(async (
    file: string,
    label: string[],
    options: {verify?: boolean, description?: string},
  ) => {
    const source = await fs.readFile(file, 'utf8')
    const basename = path.basename(file).replace(/\.[^.]+$/, '')
    const labelText = label.join(' ').trim()
    await runAndPrint({
      type: 'install-extension',
      source,
      label: labelText || basename,
      ...(options.verify ? {verify: true} : {}),
      ...(options.description !== undefined ? {description: options.description} : {}),
    })
  })

cli
  .command('enable-extension <handle>', 'Enable an installed extension by id or label')
  .action(async (handle: string) => {
    await runAndPrint({type: 'enable-extension', ...extensionHandle(handle)})
  })

cli
  .command('disable-extension <handle>', 'Disable an installed extension by id or label')
  .action(async (handle: string) => {
    await runAndPrint({type: 'disable-extension', ...extensionHandle(handle)})
  })

cli
  .command('uninstall-extension <handle>', 'Uninstall an extension by id or label')
  .action(async (handle: string) => {
    await runAndPrint({type: 'uninstall-extension', ...extensionHandle(handle)})
  })

cli
  .command('run-action <id> [depsJson]', 'Run a registered action by id')
  .action(async (id: string, depsJson: string | undefined) => {
    await runAndPrint({
      type: 'run-action',
      id,
      dependencies: depsJson ? parseJson(depsJson, 'depsJson') : {},
    })
  })

cli
  .command('eval [...code]', 'Run JS in the app. Use "return …" to print a value.')
  .option('--raw', 'Print the wire-format response instead of friendly output')
  .option('--file <path>', 'Read the code from a file instead of <code>')
  .action(async (
    code: string[],
    options: {raw?: boolean, file?: string},
  ) => {
    const codeText = options.file
      ? await fs.readFile(options.file, 'utf8')
      : code.join(' ')
    await ensureBridgeRunning()
    const value = await runCommand({type: 'eval', code: codeText})
    process.stdout.write(`${formatEvalOutput(value, Boolean(options.raw))}\n`)
  })

cli
  .command('raw <json>', 'Send a raw JSON command envelope to the bridge')
  .action(async (json: string) => {
    const command = parseJson(json, 'raw json') as CommandPayload
    await runAndPrint(command)
  })

cli.help()

const main = async () => {
  // Two-phase parse so we can resolve `--profile` (a global option)
  // before any matched action reads `selectedProfileName` for token
  // lookup or error messages.
  cli.parse(process.argv, {run: false})
  const profileOption = cli.options.profile
  if (profileOption !== undefined) {
    selectedProfileName = normalizeProfileName(String(profileOption))
  }

  // When --help / -h is set, cac has already printed the appropriate
  // (command-specific or global) help during parse — we just bail.
  if (cli.options.help) return

  // No command matched (bare `kmagent` or an unknown verb): show the
  // global help instead of erroring, matching the old behaviour where
  // the hand-written usage was printed.
  if (!cli.matchedCommand) {
    cli.outputHelp()
    return
  }

  await cli.runMatchedCommand()
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
})
