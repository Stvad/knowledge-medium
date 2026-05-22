#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  bridgeLogPath,
  bridgeSecret as resolveBridgeSecret,
  bridgeUrl as resolveBridgeUrl,
  isLocalBridgeUrl,
  pairingUrl,
  tokenStorePath as resolveTokenStorePath,
} from './agent-runtime-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverScript = path.join(here, 'agent-runtime-server.mjs')
const bridgeUrl = resolveBridgeUrl()
const pollIntervalMs = 100
const defaultTimeoutMs = 30_000
const bridgeStartTimeoutMs = 5_000
const tokenStorePath = resolveTokenStorePath()
const defaultProfileName = 'default'
let selectedProfileName = defaultProfileName

const usage = () => `
Usage:
  yarn agent [--profile <name>] <command>

Commands:
  yarn agent connect [--force]    open app pairing flow and persist pasted token
                                  (no-op when an active connection already exists; --force re-pairs)
  yarn agent connect <token>      persist token directly (or use AGENT_RUNTIME_TOKEN env)
  yarn agent disconnect           remove the selected profile token
  yarn agent remove-profile <name>  remove a saved CLI token profile
  yarn agent profiles             list saved CLI token profiles
  yarn agent pair-url             print the current app pairing URL
  yarn agent whoami               show audience the persisted token resolves to
  yarn agent ping
  yarn agent status
  yarn agent runtime-summary      show compact agent-oriented runtime context
  yarn agent describe-runtime [--actions <text>] [--facets <text>] [--guide <id>]
                               [--modules <text>] [--components <text>] [--storage]
                               [--full]
                                  show full or targeted runtime diagnostics.
                                  This is the canonical "what's registered"
                                  view — prefer it over reaching into
                                  facetRuntime / Repo internals through eval.
                                  When --guide is passed alone, response
                                  defaults to brief (just guides + storage +
                                  apiSurface, ~16KB). Pass --full to also
                                  include actions/facets/modules/components.
  yarn agent sql <all|get|optional|execute> <sql> [paramsJson]
  yarn agent get-block <id>
  yarn agent subtree <rootId> [--include-root]
  yarn agent create-block <json>
  yarn agent update-block <json>
  yarn agent install-extension [--verify] [--description <text>] <file> [label]
                                  (reload is automatic; --verify reports the
                                  facets/actions the extension contributes;
                                  label defaults to the filename without ext)
  yarn agent enable-extension <id|label>
  yarn agent disable-extension <id|label>
  yarn agent run-action <id> [depsJson]
  yarn agent eval [--raw] <code>  run JS in the app; use "return ..." to print a value
  yarn agent eval --file <path>
  yarn agent reload               hard-reload the app tab and wait for it to come back
  yarn agent navigate <hash>      set window.location.hash (with or without leading #)
  yarn agent raw <json>

Profile selection:
  --profile <name>                select a saved CLI token profile
  AGENT_RUNTIME_PROFILE=<name>    default selected profile for this command
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const canAutoStartBridge = () =>
  !process.env.AGENT_RUNTIME_URL && isLocalBridgeUrl(bridgeUrl)

const parseJson = (value, label) => {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

const parseDescribeRuntimeArgs = args => {
  const filters = {
    actions: [],
    facets: [],
    guides: [],
    modules: [],
    components: [],
    storage: false,
  }
  // Implicit brief mode: when the agent says "show me the guide" we
  // default to authoring-only output. They can pass `--full` to get
  // actions / facets / discoverable-modules back.
  let fullRequested = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const readValue = flag => {
      const value = args[i + 1]
      if (!value) throw new Error(`${flag} requires a value`)
      i += 1
      return value
    }

    if (arg === '--actions') {
      filters.actions.push(readValue(arg))
      continue
    }
    if (arg.startsWith('--actions=')) {
      filters.actions.push(arg.slice('--actions='.length))
      continue
    }
    if (arg === '--facets') {
      filters.facets.push(readValue(arg))
      continue
    }
    if (arg.startsWith('--facets=')) {
      filters.facets.push(arg.slice('--facets='.length))
      continue
    }
    if (arg === '--guide' || arg === '--guides') {
      filters.guides.push(readValue(arg))
      continue
    }
    if (arg.startsWith('--guide=')) {
      filters.guides.push(arg.slice('--guide='.length))
      continue
    }
    if (arg.startsWith('--guides=')) {
      filters.guides.push(arg.slice('--guides='.length))
      continue
    }
    if (arg === '--modules') {
      filters.modules.push(readValue(arg))
      continue
    }
    if (arg.startsWith('--modules=')) {
      filters.modules.push(arg.slice('--modules='.length))
      continue
    }
    if (arg === '--components') {
      filters.components.push(readValue(arg))
      continue
    }
    if (arg.startsWith('--components=')) {
      filters.components.push(arg.slice('--components='.length))
      continue
    }
    if (arg === '--storage') {
      filters.storage = true
      continue
    }
    if (arg === '--full') {
      fullRequested = true
      continue
    }
    throw new Error(`Unknown describe-runtime option: ${arg}`)
  }

  // Brief by default whenever --guide was the agent's intent and they
  // didn't opt into other heavy sections. If they passed any of
  // actions/facets/modules/components filters explicitly, they
  // wanted those — don't override.
  const heavyFilterPresent
    = filters.actions.length > 0
      || filters.facets.length > 0
      || filters.modules.length > 0
      || filters.components.length > 0
  const briefImplied
    = filters.guides.length > 0 && !heavyFilterPresent && !fullRequested
  if (briefImplied) filters.brief = true

  return {
    ...(filters.actions.length > 0 ? {actions: filters.actions} : {}),
    ...(filters.facets.length > 0 ? {facets: filters.facets} : {}),
    ...(filters.guides.length > 0 ? {guides: filters.guides} : {}),
    ...(filters.modules.length > 0 ? {modules: filters.modules} : {}),
    ...(filters.components.length > 0 ? {components: filters.components} : {}),
    ...(filters.storage ? {storage: true} : {}),
    ...(filters.brief ? {brief: true} : {}),
  }
}

const evalReturnedUndefined = value =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.type === 'undefined'
  && Object.keys(value).length === 1

const formatCliOutput = (verb, args, value) => {
  if (verb !== 'eval') return JSON.stringify(value, null, 2)
  if (args.includes('--raw')) return JSON.stringify(value, null, 2)
  // Eval handlers commonly run for side effects and don't `return` —
  // surface that as a single legible token instead of `{type:
  // 'undefined'}`, which is easy to mistake for an error. Same idea
  // for the explicit string "undefined" some callers return from
  // `repo.db.execute(...)` etc.
  if (value === undefined || value === null || evalReturnedUndefined(value)) {
    return '<ok: eval completed, no return value (use `return ...` to print one; pass --raw for the wire format)>'
  }
  return JSON.stringify(value, null, 2)
}

const parseInstallExtensionArgs = args => {
  let reload = false
  let verify = false
  let description
  const rest = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--reload') {
      reload = true
      continue
    }
    if (arg === '--verify') {
      verify = true
      continue
    }
    if (arg === '--description') {
      description = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--description=')) {
      description = arg.slice('--description='.length)
      continue
    }
    rest.push(arg)
  }

  const [file, ...labelParts] = rest
  if (!file) throw new Error('install-extension requires <file>')
  return {file, label: labelParts.join(' ').trim(), reload, verify, description}
}

// Accept "<id>" (UUID) or "<label>" — extensions installed via the
// bridge are tagged with their label as an alias, so a single positional
// arg can resolve to either.
const parseExtensionHandle = (verb, args) => {
  const [handle] = args
  if (!handle) throw new Error(`${verb} requires <id|label>`)
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

const parseCliArgs = args => {
  const rest = []
  let profileName = selectedProfileName

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      rest.push(...args.slice(i + 1))
      break
    }

    if (arg === '--profile' || arg === '-p') {
      const value = args[i + 1]
      if (!value) throw new Error(`${arg} requires a profile name`)
      profileName = normalizeProfileName(value)
      i += 1
      continue
    }

    if (arg.startsWith('--profile=')) {
      profileName = normalizeProfileName(arg.slice('--profile='.length))
      continue
    }

    rest.push(arg)
  }

  return {args: rest, profileName}
}

const normalizeTokenRecord = value => {
  if (!value || typeof value !== 'object' || typeof value.token !== 'string') return null
  return {
    token: value.token,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : undefined,
  }
}

const normalizeTokenStore = value => {
  const profiles = {}

  if (value && typeof value === 'object') {
    const legacy = normalizeTokenRecord(value)
    if (legacy) profiles[defaultProfileName] = legacy

    if (value.profiles && typeof value.profiles === 'object') {
      for (const [name, record] of Object.entries(value.profiles)) {
        const profileName = normalizeProfileName(name)
        const normalized = normalizeTokenRecord(record)
        if (normalized) profiles[profileName] = normalized
      }
    }
  }

  return {profiles}
}

const loadTokenStore = async () => {
  try {
    const raw = await fs.readFile(tokenStorePath, 'utf8')
    return normalizeTokenStore(JSON.parse(raw))
  } catch (error) {
    if (error.code === 'ENOENT') return {profiles: {}}
    throw error
  }
}

const writeTokenStore = async store => {
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

const loadStoredToken = async (profileName = selectedProfileName) => {
  const store = await loadTokenStore()
  return store.profiles[profileName]?.token ?? null
}

const writeStoredToken = async (token, profileName = selectedProfileName) => {
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
    if (error.code !== 'ENOENT') throw error
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

const requestJson = async (url, options = {}) => {
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

  return body
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
  let lastError = null

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

const readBridgeStatus = async () => {
  const bridgeSecret = await bridgeSecretForStatus()
  return requestJson(`${bridgeUrl}/health${bridgeSecret ? '?detail=1' : ''}`, {
    headers: bridgeSecret ? {'x-agent-runtime-secret': bridgeSecret} : {},
  })
}

const compactUser = user => {
  if (!user || typeof user !== 'object') return null
  const compact = {}
  if (typeof user.id === 'string') compact.id = user.id
  if (typeof user.name === 'string') compact.name = user.name
  return Object.keys(compact).length > 0 ? compact : null
}

const compactBridgeClient = client => {
  const metadata = client?.metadata && typeof client.metadata === 'object'
    ? client.metadata
    : {}
  const compact = {
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
  const runtime = await runCommand({type: 'ping'})
  const status = await readBridgeStatus()
  const bridge = {ok: Boolean(status?.ok)}

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

const whoamiWithToken = token =>
  requestJson(`${bridgeUrl}/runtime/whoami`, {
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

const navigateAppHash = async hash => {
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

const waitForTokenAudience = async token => {
  const startedAt = Date.now()
  let lastError = null

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

const printConnectSuccess = info => {
  const audience = info.audience ?? {}
  process.stdout.write(
    `Connected. Token saved at ${tokenStorePath} (profile: ${selectedProfileName})\n` +
    `User: ${audience.userId ?? '?'}\n` +
    `Workspace: ${audience.workspaceId ?? '?'}\n` +
    `Connected client: ${info.connected ? 'yes' : 'no (will auto-connect when the app reaches the bridge)'}\n`,
  )
}

const connectWithToken = async (token, options = {}) => {
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
      `Token saved at ${tokenStorePath} (profile: ${selectedProfileName}), but bridge contact failed: ${error.message}\n` +
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
const isTransientTokenError = (error) => {
  const message = String(error?.message ?? '')
  return message.includes('Unknown or expired token')
    || message.includes('Missing or invalid command status credentials')
}

const authedRetryTotalMs = 15_000
const authedRetryStartDelayMs = 200
const authedRetryMaxDelayMs = 1_000

const authedRequest = async (url, options = {}) => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(
      `No agent token configured for profile "${selectedProfileName}". Run \`yarn agent --profile ${selectedProfileName} connect\` to pair the CLI with the app.`,
    )
  }

  const send = () => requestJson(url, {
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

const submitCommand = async command => {
  const response = await authedRequest(`${bridgeUrl}/runtime/commands`, {
    method: 'POST',
    body: JSON.stringify(command),
  })

  return response.id
}

const waitForCommand = async (id, timeoutMs = defaultTimeoutMs) => {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const command = await authedRequest(`${bridgeUrl}/runtime/commands/${id}`)
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

const runCommand = async command => {
  const id = await submitCommand(command)
  const result = await waitForCommand(id)

  if (!result?.ok) {
    const error = result?.error
    throw new Error(error?.message ?? 'Runtime command failed')
  }

  return result.value
}

const commandFromArgs = async args => {
  const [name, ...rest] = args

  switch (name) {
    case 'ping':
      return {type: 'ping'}

    case 'runtime-summary':
      return {type: name}

    case 'describe-runtime':
      return {
        type: name,
        ...parseDescribeRuntimeArgs(rest),
      }

    case 'sql': {
      const [mode, sql, paramsJson] = rest
      if (!mode || !sql) {
        throw new Error('sql requires <mode> and <sql>')
      }

      return {
        type: 'sql',
        mode,
        sql,
        params: paramsJson ? parseJson(paramsJson, 'paramsJson') : [],
      }
    }

    case 'get-block': {
      const [id] = rest
      if (!id) throw new Error('get-block requires <id>')
      return {type: 'get-block', id}
    }

    case 'subtree': {
      const includeRoot = rest.includes('--include-root')
      const rootId = rest.find(arg => arg !== '--include-root')
      if (!rootId) throw new Error('subtree requires <rootId>')
      return {
        type: 'get-subtree',
        rootId,
        includeRoot,
      }
    }

    case 'create-block':
      return {
        type: 'create-block',
        ...parseJson(rest.join(' '), 'create-block json'),
      }

    case 'update-block':
      return {
        type: 'update-block',
        ...parseJson(rest.join(' '), 'update-block json'),
      }

    case 'install-extension': {
      const {file, label, reload, verify, description} = parseInstallExtensionArgs(rest)
      const source = await fs.readFile(file, 'utf8')
      const basename = path.basename(file).replace(/\.[^.]+$/, '')
      return {
        type: 'install-extension',
        source,
        label: label || basename,
        ...(reload ? {reload: true} : {}),
        ...(verify ? {verify: true} : {}),
        ...(description !== undefined ? {description} : {}),
      }
    }

    case 'enable-extension':
      return {type: 'enable-extension', ...parseExtensionHandle('enable-extension', rest)}

    case 'disable-extension':
      return {type: 'disable-extension', ...parseExtensionHandle('disable-extension', rest)}

    case 'run-action': {
      const [id, depsJson] = rest
      if (!id) throw new Error('run-action requires <id>')
      return {
        type: 'run-action',
        id,
        dependencies: depsJson ? parseJson(depsJson, 'depsJson') : {},
      }
    }

    case 'eval': {
      const evalArgs = rest.filter(a => a !== '--raw')
      if (evalArgs[0] === '--file') {
        if (!evalArgs[1]) throw new Error('eval --file requires <path>')
        return {
          type: 'eval',
          code: await fs.readFile(evalArgs[1], 'utf8'),
        }
      }

      return {
        type: 'eval',
        code: evalArgs.join(' '),
      }
    }

    case 'raw':
      return parseJson(rest.join(' '), 'raw json')

    default:
      throw new Error(`Unknown command: ${name ?? ''}`)
  }
}

const main = async () => {
  const parsed = parseCliArgs(process.argv.slice(2))
  const args = parsed.args
  selectedProfileName = parsed.profileName

  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }

  const verb = args[0]

  if (verb === 'connect') {
    const forceIdx = args.indexOf('--force')
    const force = forceIdx > 0
    const positional = args.slice(1).filter(a => a !== '--force')
    const token = positional[0]?.trim() || process.env.AGENT_RUNTIME_TOKEN?.trim()
    if (token) {
      await connectWithToken(token)
    } else {
      await connectInteractively({force})
    }
    return
  }

  if (verb === 'disconnect') {
    const removed = await removeStoredToken()
    process.stdout.write(
      removed
        ? `Removed profile "${selectedProfileName}" from ${tokenStorePath}\n`
        : `No token profile "${selectedProfileName}" exists in ${tokenStorePath}\n`,
    )
    return
  }

  if (verb === 'remove-profile' || verb === 'disconnect-profile') {
    const profileName = normalizeProfileName(args[1] ?? '')
    if (!args[1]) {
      throw new Error(`${verb} requires a profile name`)
    }
    const removed = await removeStoredToken(profileName)
    process.stdout.write(
      removed
        ? `Removed profile "${profileName}" from ${tokenStorePath}\n`
        : `No token profile "${profileName}" exists in ${tokenStorePath}\n`,
    )
    return
  }

  if (verb === 'profiles') {
    const profiles = await listStoredProfiles()
    process.stdout.write(`${JSON.stringify({
      tokenStorePath,
      selectedProfile: selectedProfileName,
      profiles,
    }, null, 2)}\n`)
    return
  }

  if (verb === 'pair-url') {
    await ensureBridgeRunning()
    process.stdout.write(`${await pairingUrl()}\n`)
    return
  }

  if (verb === 'whoami') {
    await ensureBridgeRunning()
    const token = await resolveToken()
    if (!token) {
      throw new Error(`No agent token configured for profile "${selectedProfileName}". Run \`yarn agent --profile ${selectedProfileName} connect\` first.`)
    }
    const info = await whoamiWithToken(token)
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
    return
  }

  if (verb === 'ping') {
    await printPing()
    return
  }

  if (verb === 'status') {
    await ensureBridgeRunning()
    const status = await readBridgeStatus()
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return
  }

  if (verb === 'reload') {
    await ensureBridgeRunning()
    const info = await reloadAppAndWait()
    process.stdout.write(`${JSON.stringify({ok: true, reconnected: info}, null, 2)}\n`)
    return
  }

  if (verb === 'navigate') {
    const hash = args[1]
    if (hash === undefined) throw new Error('navigate requires a hash')
    await ensureBridgeRunning()
    await navigateAppHash(hash)
    process.stdout.write(`${JSON.stringify({ok: true, hash: hash.startsWith('#') ? hash : `#${hash}`}, null, 2)}\n`)
    return
  }

  await ensureBridgeRunning()
  const command = await commandFromArgs(args)
  const value = await runCommand(command)
  process.stdout.write(`${formatCliOutput(verb, args, value)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
