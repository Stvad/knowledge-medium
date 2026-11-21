import {provideRuntimeGlobals} from '../agent-eval/nodeShims'
import {PowerSyncDatabase} from '@powersync/node'
import {createClientPowerSyncSchema, initializeClientDatabase} from '@/data/internals/initializeClientDatabase'
import {dbFilenameForUser} from '@/data/localDbStorage'
import {BlockCache} from '@/data/blockCache'
import {Repo} from '@/data/repo'
import {readWorkspaceEncryptionMode} from '@/data/workspaceSchema'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import type {GateWorkspace} from '@/sync/keys/resolveWorkspaceEntry'
import {createSyncResolver} from '@/sync/keys/resolver'
import {connectWorkspaceSync, hasRemoteSyncConfig} from '@/services/powersync'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {createAgentRuntimeContext} from '@/plugins/agent-runtime/commands'
import {watchEventsRegistry} from '@/plugins/agent-runtime/watchEvents'
import {openWorkspaceData} from '@/bootstrap/openWorkspaceData'
import type {User} from '@/types'
import {resolveAppVersion} from '../app-version'
import {openDeviceWorkspace} from './access'
import {startReadGate} from './gate'
import {executeHeadlessCommand} from './commands'
import {connectBridge, type HostBridge} from './bridge'
import type {HeadlessConfig} from './config'

const workspaceSql = 'SELECT encryption_mode AS encryptionMode, name, wk_canary AS wkCanary FROM workspaces WHERE id = ?'

async function waitForWorkspace(db: PowerSyncDatabase, workspaceId: string, signal: AbortSignal) {
  for await (const result of db.watch(workspaceSql, [workspaceId], {signal})) {
    const row = result.rows?.item(0) as GateWorkspace | undefined
    if (row) return row
  }
  signal.throwIfAborted()
  throw new Error('Workspace subscription ended')
}

const untilAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))

/** Owns sync and the Repo. The caller owns the open database. */
export async function serveDatabase(
  db: PowerSyncDatabase, config: HeadlessConfig, user: User, signal: AbortSignal,
  connect = connectWorkspaceSync, register = connectBridge,
) {
  const {workspaceId} = config
  await db.waitForReady()
  const baseline = db.currentStatus.lastSyncedAt?.getTime()
  await initializeClientDatabase(db, 'node')
  if (await db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')) {
    throw new Error('Read-only host found queued writes. Preserve this database for recovery.')
  }
  const resolver = createSyncResolver(() => user.id, getWorkspaceKeyStore(), id => readWorkspaceEncryptionMode(db, id))
  const connectDb = () => connect(db, dbFilenameForUser(user.id), resolver)
  let repo: Repo | undefined
  let gate: ReturnType<typeof startReadGate> | undefined
  let bridge: HostBridge | undefined
  let releaseBulk: (() => void) | undefined
  try {
    const existing = await db.getOptional<GateWorkspace>(workspaceSql, [workspaceId])
    if (!existing) await connectDb()
    const row = existing ?? await waitForWorkspace(db, workspaceId, signal)
    signal.throwIfAborted()
    await openDeviceWorkspace(config, user.id, row)
    if (existing) await connectDb()
    const cold = !await db.getOptional('SELECT 1 FROM blocks WHERE workspace_id = ? LIMIT 1', [workspaceId])
    const active = new Repo({db, user, cache: new BlockCache(), syncObserverDeps: resolver, isReadOnly: true})
    repo = active
    if (cold) releaseBulk = active.holdBulkSyncLoad(workspaceId)
    active.setActiveWorkspaceId(workspaceId)
    const runtime = resolveFacetRuntimeSync(staticDataExtensions, {repo: active, workspaceId, safeMode: false})
    active.setFacetRuntime(runtime)
    const commit = resolveAppVersion().sha
    const context = createAgentRuntimeContext({
      repo: active, runtime, safeMode: false,
      hostHealth: () => ({
        commit, readOnly: active.isReadOnly,
        baselineSyncedAt: baseline ?? null,
        lastSyncedAt: db.currentStatus.lastSyncedAt?.getTime() ?? null,
        closedReason: gate ? gate.reason() : 'Starting gate',
      }),
    })
    bridge = await register(config, user, async command => {
      signal.throwIfAborted()
      return executeHeadlessCommand(command, context, async () => {
        if (!gate) return 'Starting gate'
        await gate.refresh()
        return gate.reason()
      })
    })
    const transport = bridge.postEvent
    gate = startReadGate(db, active, workspaceId, baseline, async () => {
      await Promise.all(await openWorkspaceData(active, workspaceId))
    }, visible => {
      if (visible) {
        releaseBulk?.()
        releaseBulk = undefined
        watchEventsRegistry.setTransport(transport)
      } else {
        watchEventsRegistry.disposeAll()
      }
    })
    await untilAbort(signal)
  } finally {
    try {
      await bridge?.close()
    } finally {
      watchEventsRegistry.disposeAll()
      watchEventsRegistry.setTransport(null)
      await gate?.stop()
      releaseBulk?.()
      await db.disconnect()
      if (repo) {
        await repo.flushSyncObserver()
        repo.stopSyncObserver()
        repo.setActiveWorkspaceId(null)
        await repo.awaitDeferredWork()
        repo.cancelDelayedProcessors()
      }
    }
  }
}

export async function runHost(config: HeadlessConfig, user: User, signal: AbortSignal) {
  if (!hasRemoteSyncConfig) throw new Error('Set VITE_POWERSYNC_URL to run the headless host')
  provideRuntimeGlobals()
  const db = new PowerSyncDatabase({
    schema: createClientPowerSyncSchema(),
    database: {dbLocation: config.stateDir, dbFilename: dbFilenameForUser(user.id), readWorkerCount: 1},
  })
  try {
    await serveDatabase(db, config, user, signal)
  } catch (error) {
    if (!signal.aborted || error !== signal.reason) throw error
  } finally {
    await db.close()
  }
  if (signal.aborted && signal.reason?.name !== 'AbortError') throw signal.reason
}
