#!/usr/bin/env node
import {readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { cac } from 'cac'
import {
  bridgeLogPath,
  bridgeSecret as resolveBridgeSecret,
  bridgeUrl as resolveBridgeUrl,
  isErrnoException,
  isLocalBridgeUrl,
  pairingUrl,
  tokenStorePath as resolveTokenStorePath,
} from './config.js'
import {
  type Audience,
  getCommandMeta,
  type KnownCommand,
  type KnownCommandType,
  moveBlockCommandSchema,
  sqlModeSchema,
  type WhoamiInfo,
} from './protocol.js'
import {
  createBridgeClient,
  defaultProfileName,
  errorMessage,
  startBridgeInBackground,
  listStoredProfiles as listProfilesInStore,
  loadStoredToken as loadStoredTokenFor,
  normalizeProfileName,
  removeStoredToken as removeStoredTokenFor,
  requestJson,
  sleep,
  writeStoredToken as writeStoredTokenFor,
} from './client.js'
import {
  kernelTypeDeclarationCandidates,
  renderKernelTypesInstallSummary,
} from './kernelDts.js'
import {renderSubtreeOutline} from './subtreeOutline.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const kernelTypesDir = path.join(here, 'kernel-types')

// Read our own version from package.json at startup so `--version`
// stays in sync without a build-time codegen step. `here` is dist/, so
// the package.json is one level up.
const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {version?: string}
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const bridgeUrl = resolveBridgeUrl()
const bridgeStartTimeoutMs = 5_000
const tokenStorePath = resolveTokenStorePath()
let selectedProfileName = defaultProfileName

/** Bridge client bound to the currently selected profile. Created per
 *  call because `--profile` mutates `selectedProfileName` after parse. */
const client = () => createBridgeClient({profile: selectedProfileName})

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

// `--filter` / `--grouping` accept either a mode keyword (passed through
// as a string) or inline JSON (an explicit filter / grouping object).
// The kernel coerces whichever form it receives.
const parseSpecArg = (
  value: unknown,
  modes: readonly string[],
  label: string,
): string | unknown | undefined => {
  if (value === undefined) return undefined
  const text = String(value)
  if (modes.includes(text)) return text
  return parseJson(text, label)
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

selectedProfileName = normalizeProfileName(process.env.AGENT_RUNTIME_PROFILE ?? '')

const assertBundledKernelTypes = async (): Promise<void> => {
  try {
    const stat = await fs.stat(kernelTypesDir)
    if (stat.isDirectory()) return
    throw new Error(`Compiled kernel types path is not a directory: ${kernelTypesDir}`)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error(
        `Compiled kernel type tree is missing at ${kernelTypesDir}. `
        + 'Run the package build before using `kmagent types` from source.',
        {cause: error},
      )
    }
    throw error
  }
}

const countFiles = async (dir: string): Promise<number> => {
  const entries = await fs.readdir(dir, {withFileTypes: true})
  let count = 0
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    count += entry.isDirectory() ? await countFiles(fullPath) : 1
  }
  return count
}

const directoryHasEntries = async (dir: string): Promise<boolean> => {
  try {
    const entries = await fs.readdir(dir)
    return entries.length > 0
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const normalizeTsconfigPath = (value: string): string => {
  const normalized = value.split(path.sep).join('/')
  return normalized === '' ? '.' : normalized
}

const writeKernelTypes = async (
  outDir: string,
  options: {force?: boolean} = {},
): Promise<{fileCount: number, pathsTarget: string}> => {
  await assertBundledKernelTypes()

  const exists = await directoryHasEntries(outDir)
  if (exists) {
    if (!options.force) {
      throw new Error(`Type output directory is not empty: ${outDir}. Pass --force to replace it.`)
    }
    await fs.rm(outDir, {recursive: true, force: true})
  }

  await fs.mkdir(path.dirname(outDir), {recursive: true})
  await fs.cp(kernelTypesDir, outDir, {recursive: true})

  const fileCount = await countFiles(outDir)
  const pathsTarget = normalizeTsconfigPath(path.relative(process.cwd(), path.join(outDir, 'src')))
  return {fileCount, pathsTarget}
}

const readKernelTypeModuleDeclaration = async (moduleSpec: string): Promise<string> => {
  await assertBundledKernelTypes()

  const tried: string[] = []
  for (const candidate of kernelTypeDeclarationCandidates(moduleSpec)) {
    const declarationPath = path.join(kernelTypesDir, candidate)
    tried.push(declarationPath)
    try {
      return await fs.readFile(declarationPath, 'utf8')
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    }
  }

  throw new Error(
    `No compiled declaration found for ${moduleSpec}. Tried:\n`
    + tried.map(candidate => `  - ${candidate}`).join('\n'),
  )
}

// Thin delegates binding the store helpers from client.ts to the
// currently selected `--profile`.
const loadStoredToken = (profileName = selectedProfileName) => loadStoredTokenFor(profileName)
const writeStoredToken = (token: string, profileName = selectedProfileName) => writeStoredTokenFor(token, profileName)
const removeStoredToken = (profileName = selectedProfileName) => removeStoredTokenFor(profileName)
const listStoredProfiles = () => listProfilesInStore(selectedProfileName)
const resolveToken = () => client().resolveToken()

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

const fetchBridgeHealth = () => client().health()

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
  process.stderr.write(`Started agent runtime bridge in the background at ${bridgeUrl}. Logs: ${bridgeLogPath()}\n`)
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
  createBridgeClient({token}).whoami()

const reloadAppAndWait = async ({timeoutMs = 30_000} = {}) => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(`No agent token configured for profile "${selectedProfileName}". Run \`kmagent --profile ${selectedProfileName} connect\` first.`)
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
      `Make sure the app tab is open. Run \`kmagent whoami\` to verify.\n`,
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
        `Open or focus the app tab, or run \`kmagent whoami\` to recheck. Re-pairing anyway…\n\n`,
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

const runCommand = (command: KnownCommand): Promise<unknown> =>
  client().runCommand(command)

/** Helper: connect to the bridge, run a wire-protocol command, and
 *  pretty-print the result. Used by the "thin" bridge-fronting commands
 *  (sql, get-block, runtime-summary, install-extension, …). */
const runAndPrint = async (command: KnownCommand): Promise<void> => {
  await ensureBridgeRunning()
  const value = await runCommand(command)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const cli = cac('kmagent')

/** Resolve a cac command's description from the wire-command registry
 *  so the cli.ts surface and the runtime-summary surface share a
 *  single source of truth. The kebab-cased `kmagent` verb (e.g.
 *  `subtree`) sometimes differs from the wire type (`get-subtree`);
 *  callers pass the wire type to be unambiguous. */
const wireDescription = (type: KnownCommandType): string =>
  getCommandMeta(type).description

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
        + `Run \`kmagent --profile ${selectedProfileName} connect\` first.`,
      )
    }
    const info = await whoamiWithToken(token)
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
  })

cli
  .command('ping', wireDescription('ping'))
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
  .command('runtime-summary', wireDescription('runtime-summary'))
  .action(async () => {
    await runAndPrint({type: 'runtime-summary'})
  })

cli
  .command('health', wireDescription('health'))
  .action(async () => {
    await runAndPrint({type: 'health'})
  })

cli
  .command('describe-runtime', wireDescription('describe-runtime'))
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
  .command('sql <mode> <sql> [paramsJson]', wireDescription('sql'))
  .option(
    '--allow-synced-write',
    'Override the refusal to write to a synced table (blocks/workspaces/workspace_members) via raw SQL — such a write bypasses repo.tx, so it never uploads and skips the kernel derivations. Use deliberately.',
  )
  .action(async (mode: string, sql: string, paramsJson: string | undefined, options: {allowSyncedWrite?: boolean}) => {
    // Parse mode + params through the schemas so an invalid `--mode`
    // or non-array params fails fast with a clear error instead of
    // round-tripping to the bridge for a less specific rejection.
    const parsedMode = sqlModeSchema.safeParse(mode)
    if (!parsedMode.success) {
      throw new Error(`sql mode must be one of: all|get|optional|execute (got "${mode}")`)
    }
    const params = paramsJson ? parseJson(paramsJson, 'paramsJson') : []
    if (!Array.isArray(params)) {
      throw new Error('paramsJson must be a JSON array')
    }
    await runAndPrint({
      type: 'sql',
      mode: parsedMode.data,
      sql,
      params,
      ...(options.allowSyncedWrite ? {allowSyncedWrite: true} : {}),
    })
  })

cli
  .command('get-block <id>', wireDescription('get-block'))
  .action(async (id: string) => {
    await runAndPrint({type: 'get-block', id})
  })

cli
  .command('subtree <rootId>', wireDescription('get-subtree'))
  .option('--json', 'Print the raw flat array (each row a block + its depth) instead of the indented outline')
  .option('--props', "Append each block's properties as compact JSON after its content")
  .action(async (rootId: string, options: {json?: boolean, props?: boolean}) => {
    if (options.json) {
      await runAndPrint({type: 'get-subtree', rootId})
      return
    }
    // Default: a depth-indented `- [id] content` outline. The subtree
    // comes back already in pre-order / (order_key, id) order — we render
    // it verbatim and never re-sort (see renderSubtreeOutline).
    await ensureBridgeRunning()
    const value = await runCommand({type: 'get-subtree', rootId})
    process.stdout.write(`${renderSubtreeOutline(value, {includeProperties: options.props})}\n`)
  })

cli
  .command('backlinks <blockId>', wireDescription('backlinks'))
  .option('--filter <spec>', 'none|stored|effective, or inline JSON BacklinksFilter (default: none)')
  .option('--workspace <id>', "Workspace id (defaults to the block's workspace, then the active one)")
  .action(async (blockId: string, options: {filter?: string, workspace?: string}) => {
    const filter = parseSpecArg(options.filter, ['none', 'stored', 'effective'], '--filter')
    await runAndPrint({
      type: 'backlinks',
      id: blockId,
      ...(filter !== undefined ? {filter} : {}),
      ...(options.workspace ? {workspaceId: options.workspace} : {}),
    })
  })

cli
  .command('grouped-backlinks <blockId>', wireDescription('grouped-backlinks'))
  .option('--filter <spec>', 'none|stored|effective, or inline JSON BacklinksFilter (default: none)')
  .option('--grouping <spec>', 'user|none, or inline JSON grouping config (default: user)')
  .option('--workspace <id>', "Workspace id (defaults to the block's workspace, then the active one)")
  .action(async (
    blockId: string,
    options: {filter?: string, grouping?: string, workspace?: string},
  ) => {
    const filter = parseSpecArg(options.filter, ['none', 'stored', 'effective'], '--filter')
    const grouping = parseSpecArg(options.grouping, ['user', 'none'], '--grouping')
    await runAndPrint({
      type: 'grouped-backlinks',
      id: blockId,
      ...(filter !== undefined ? {filter} : {}),
      ...(grouping !== undefined ? {grouping} : {}),
      ...(options.workspace ? {workspaceId: options.workspace} : {}),
    })
  })

cli
  .command('data-model', wireDescription('data-model'))
  .action(async () => {
    await ensureBridgeRunning()
    const value = await runCommand({type: 'data-model'})
    process.stdout.write(
      typeof value === 'string'
        ? `${value}\n`
        : `${JSON.stringify(value, null, 2)}\n`,
    )
  })

cli
  .command('page [...name]', wireDescription('page'))
  .option('--workspace <id>', 'Workspace id (defaults to the active one)')
  .option('--limit <n>', 'Max substring candidates (default 20)')
  .action(async (name: unknown, options: {workspace?: string, limit?: string}) => {
    const text = toStringArray(name).join(' ').trim()
    if (!text) throw new Error('page requires a <name> (e.g. `kmagent page "Project Alpha"`)')
    await runAndPrint({
      type: 'page',
      name: text,
      ...(options.workspace ? {workspaceId: options.workspace} : {}),
      ...(options.limit !== undefined ? {limit: Number(options.limit)} : {}),
    })
  })

cli
  .command('daily-note [...date]', wireDescription('daily-note'))
  .option('--workspace <id>', 'Workspace id (defaults to the active one)')
  .action(async (date: unknown, options: {workspace?: string}) => {
    const text = toStringArray(date).join(' ').trim()
    if (!text) throw new Error('daily-note requires a <date> (e.g. `kmagent daily-note yesterday`)')
    await runAndPrint({
      type: 'daily-note',
      date: text,
      ...(options.workspace ? {workspaceId: options.workspace} : {}),
    })
  })

cli
  .command('search [...query]', wireDescription('search'))
  .option('--workspace <id>', 'Workspace id (defaults to the active one)')
  .option('--limit <n>', 'Max results (default 50)')
  .action(async (query: unknown, options: {workspace?: string, limit?: string}) => {
    const text = toStringArray(query).join(' ').trim()
    if (!text) throw new Error('search requires a <query>')
    await runAndPrint({
      type: 'search',
      query: text,
      ...(options.workspace ? {workspaceId: options.workspace} : {}),
      ...(options.limit !== undefined ? {limit: Number(options.limit)} : {}),
    })
  })

cli
  .command('create-block <json>', wireDescription('create-block'))
  .action(async (json: string) => {
    const parsed = parseJson(json, 'create-block json') as Record<string, unknown>
    await runAndPrint({type: 'create-block', ...parsed})
  })

cli
  .command('update-block <json>', wireDescription('update-block'))
  .action(async (json: string) => {
    const parsed = parseJson(json, 'update-block json') as Record<string, unknown>
    await runAndPrint({type: 'update-block', ...parsed})
  })

cli
  .command('move-block <json>', wireDescription('move-block'))
  .action(async (json: string) => {
    const parsed = parseJson(json, 'move-block json') as Record<string, unknown>
    await runAndPrint(moveBlockCommandSchema.parse({type: 'move-block', ...parsed}))
  })

cli
  .command('delete-block <id>', wireDescription('delete-block'))
  .action(async (id: string) => {
    await runAndPrint({type: 'delete-block', id})
  })

cli
  .command('restore-block <id>', wireDescription('restore-block'))
  .action(async (id: string) => {
    await runAndPrint({type: 'restore-block', id})
  })

cli
  .command('install-extension <file> [...label]', wireDescription('install-extension'))
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
  .command('enable-extension <handle>', wireDescription('enable-extension'))
  .action(async (handle: string) => {
    await runAndPrint({type: 'enable-extension', ...extensionHandle(handle)})
  })

cli
  .command('disable-extension <handle>', wireDescription('disable-extension'))
  .action(async (handle: string) => {
    await runAndPrint({type: 'disable-extension', ...extensionHandle(handle)})
  })

cli
  .command('uninstall-extension <handle>', wireDescription('uninstall-extension'))
  .action(async (handle: string) => {
    await runAndPrint({type: 'uninstall-extension', ...extensionHandle(handle)})
  })

cli
  .command('run-action <id> [depsJson]', wireDescription('run-action'))
  .action(async (id: string, depsJson: string | undefined) => {
    const dependencies = depsJson ? parseJson(depsJson, 'depsJson') : {}
    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
      throw new Error('depsJson must be a JSON object')
    }
    await runAndPrint({
      type: 'run-action',
      id,
      dependencies: dependencies as Record<string, unknown>,
    })
  })

cli
  .command('eval [...code]', wireDescription('eval'))
  .option('--raw', 'Print the wire-format response instead of friendly output')
  .option('--file <path>', 'Read the code from a file instead of <code>')
  .option('--data <path>', 'Read JSON from a file and bind it as `data` in the eval scope')
  .option('--data-json <json>', 'Inline JSON to bind as `data` in the eval scope (mutually exclusive with --data)')
  .action(async (
    code: string[],
    options: {raw?: boolean, file?: string, data?: string, dataJson?: string},
  ) => {
    if (options.data !== undefined && options.dataJson !== undefined) {
      throw new Error('Pass either --data <path> or --data-json <json>, not both.')
    }
    const codeText = options.file
      ? await fs.readFile(options.file, 'utf8')
      : code.join(' ')
    const dataValue = options.data !== undefined
      ? parseJson(await fs.readFile(options.data, 'utf8'), `--data ${options.data}`)
      : options.dataJson !== undefined
        ? parseJson(options.dataJson, '--data-json')
        : undefined
    await ensureBridgeRunning()
    const command: KnownCommand = options.data !== undefined || options.dataJson !== undefined
      ? {type: 'eval', code: codeText, data: dataValue}
      : {type: 'eval', code: codeText}
    const value = await runCommand(command)
    process.stdout.write(`${formatEvalOutput(value, Boolean(options.raw))}\n`)
  })

cli
  .command('raw <json>', 'Send a raw JSON command envelope to the bridge')
  .action(async (json: string) => {
    // `raw` is the typed-discrimination escape hatch — the user
    // explicitly wants to send whatever they wrote, including future
    // command types the CLI doesn't know about yet. The cast lets
    // them through; the bridge / kernel still rejects malformed
    // bodies.
    const command = parseJson(json, 'raw json') as KnownCommand
    await runAndPrint(command)
  })

cli
  .command('types [outDir]', 'Write compiled TypeScript declarations for Knowledge Medium @/ modules to a directory.')
  .option('--out-dir <path>', 'Directory to write declarations into')
  .option('--module <spec>', 'Print the compiled declaration for one @/ module instead of writing the tree')
  .option('--force', 'Replace a non-empty output directory')
  .action(async (
    outDirArg: string | undefined,
    options: {outDir?: string, module?: string, force?: boolean},
  ) => {
    if (outDirArg && options.outDir) {
      throw new Error('Pass either [outDir] or --out-dir, not both.')
    }
    if (options.module) {
      if (outDirArg || options.outDir) {
        throw new Error('Pass --module by itself; it prints a single declaration to stdout.')
      }
      process.stdout.write(await readKernelTypeModuleDeclaration(options.module))
      return
    }

    const outDir = path.resolve(options.outDir ?? outDirArg ?? 'agent-extensions/kernel-types')
    const result = await writeKernelTypes(outDir, {force: Boolean(options.force)})
    process.stdout.write(renderKernelTypesInstallSummary({
      outDir,
      fileCount: result.fileCount,
      pathsTarget: result.pathsTarget,
    }))
  })

cli.version(pkgVersion)
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

  // When --help / -h or --version / -v is set, cac has already
  // printed the appropriate output during parse — we just bail.
  if (cli.options.help || cli.options.version) return

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
