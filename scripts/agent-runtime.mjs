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

const usage = () => `
Usage:
  yarn agent connect              open app pairing flow and persist pasted token
  yarn agent connect <token>      persist token directly (or use AGENT_RUNTIME_TOKEN env)
  yarn agent disconnect           remove the persisted token
  yarn agent pair-url             print the current app pairing URL
  yarn agent whoami               show audience the persisted token resolves to
  yarn agent ping
  yarn agent status
  yarn agent runtime-summary      show compact agent-oriented runtime context
  yarn agent describe-runtime     show full runtime diagnostics
  yarn agent sql <all|get|optional|execute> <sql> [paramsJson]
  yarn agent get-block <id>
  yarn agent subtree <rootId> [--include-root]
  yarn agent create-block <json>
  yarn agent update-block <json>
  yarn agent install-extension <file> [label]
  yarn agent eval <code>
  yarn agent eval --file <path>
  yarn agent raw <json>
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

const loadStoredToken = async () => {
  try {
    const raw = await fs.readFile(tokenStorePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.token === 'string') return parsed.token
    return null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const writeStoredToken = async token => {
  await fs.mkdir(path.dirname(tokenStorePath), {recursive: true})
  await fs.writeFile(
    tokenStorePath,
    JSON.stringify({token, savedAt: Date.now()}, null, 2),
    {mode: 0o600},
  )
}

const removeStoredToken = async () => {
  try {
    await fs.unlink(tokenStorePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
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
    runtime,
    bridge,
  }, null, 2)}\n`)
}

const whoamiWithToken = token =>
  requestJson(`${bridgeUrl}/runtime/whoami`, {
    headers: {authorization: `Bearer ${token}`},
  })

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
    `Connected. Token saved at ${tokenStorePath}\n` +
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
      `Token saved at ${tokenStorePath}, but bridge contact failed: ${error.message}\n` +
      `Make sure the app tab is open. Run \`yarn agent whoami\` to verify.\n`,
    )
  }
}

const connectInteractively = async () => {
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

const authedRequest = async (url, options = {}) => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(
      'No agent token configured. Run `yarn agent connect` to pair the CLI with the app.',
    )
  }

  return requestJson(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  })
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
    case 'describe-runtime':
      return {type: name}

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
      const [file, ...labelParts] = rest
      if (!file) throw new Error('install-extension requires <file>')
      const source = await fs.readFile(file, 'utf8')
      const basename = path.basename(file).replace(/\.[^.]+$/, '')
      return {
        type: 'install-extension',
        source,
        label: labelParts.join(' ').trim() || basename,
      }
    }

    case 'eval': {
      if (rest[0] === '--file') {
        if (!rest[1]) throw new Error('eval --file requires <path>')
        return {
          type: 'eval',
          code: await fs.readFile(rest[1], 'utf8'),
        }
      }

      return {
        type: 'eval',
        code: rest.join(' '),
      }
    }

    case 'raw':
      return parseJson(rest.join(' '), 'raw json')

    default:
      throw new Error(`Unknown command: ${name ?? ''}`)
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }

  const verb = args[0]

  if (verb === 'connect') {
    const token = args[1]?.trim()
    if (token) {
      await connectWithToken(token)
    } else {
      await connectInteractively()
    }
    return
  }

  if (verb === 'disconnect') {
    await removeStoredToken()
    process.stdout.write(`Removed ${tokenStorePath}\n`)
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
      throw new Error('No agent token configured. Run `yarn agent connect` first.')
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

  await ensureBridgeRunning()
  const command = await commandFromArgs(args)
  const value = await runCommand(command)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
