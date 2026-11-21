import {provideRuntimeGlobals} from '../agent-eval/nodeShims'
import {setTimeout as nextTimerTurn} from 'node:timers/promises'
import {PowerSyncDatabase} from '@powersync/node'
import {createClientPowerSyncSchema, initializeClientDatabase} from '@/data/internals/initializeClientDatabase'
import {dbFilenameForUser} from '@/data/localDbStorage'
import {BlockCache} from '@/data/blockCache'
import {Repo} from '@/data/repo'
import {parseWorkspaceRow, readWorkspaceEncryptionMode, type WorkspaceRow} from '@/data/workspaceSchema'
import {SELECT_LOCAL_WORKSPACE_BY_ID_SQL} from '@/data/workspaces'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {createSyncResolver} from '@/sync/keys/resolver'
import {connectWorkspaceSync, createWorkspaceConnector, hasRemoteSyncConfig} from '@/services/powersync'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {createAgentRuntimeContext} from '@/plugins/agent-runtime/commands'
import {watchEventsRegistry} from '@/plugins/agent-runtime/watchEvents'
import {openWorkspaceData} from '@/bootstrap/openWorkspaceData'
import {untilStopped} from '@/utils/untilStopped'
import type {User} from '@/types'
import {resolveAppVersion} from '../app-version'
import {openDeviceWorkspace} from './access'
import {startReadGate} from './gate'
import {readUploadQueue, staleUploadHold, STALE_QUEUE_REASON} from './uploadHold'
import {executeHeadlessCommand} from './commands'
import {connectBridge, type HostBridge} from './bridge'
import type {HeadlessConfig} from './config'

async function waitForWorkspace(db: PowerSyncDatabase, workspaceId: string, signal: AbortSignal) {
  for await (const result of db.watch(SELECT_LOCAL_WORKSPACE_BY_ID_SQL, [workspaceId], {signal})) {
    const row = result.rows?.item<WorkspaceRow>(0)
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
  connect = connectWorkspaceSync, register = connectBridge, releaseStaleQueue = false,
) {
  const {workspaceId} = config
  await db.waitForReady()
  const baseline = db.currentStatus.lastSyncedAt?.getTime()
  await initializeClientDatabase(db, 'node')
  const queue = await readUploadQueue(db)
  if (!config.writable && queue.queuedEntries) {
    throw new Error('Read-only host found queued writes. Preserve this database for recovery.')
  }
  const resolver = createSyncResolver(() => user.id, getWorkspaceKeyStore(), id => readWorkspaceEncryptionMode(db, id))
  let repo: Repo | undefined
  let gate: ReturnType<typeof startReadGate> | undefined
  let bridge: HostBridge | undefined
  let releaseBulk: (() => void) | undefined
  try {
    const existing = await db.getOptional<WorkspaceRow>(SELECT_LOCAL_WORKSPACE_BY_ID_SQL, [workspaceId])
    // A cold database can download to discover its mode. Replaying prior writes
    // requires a validated workspace row and pin before installing the uploader.
    if (!existing && queue.queuedEntries) throw new Error('Queued writes without a workspace row. Preserve this database for recovery.')
    const hold = staleUploadHold(db, workspaceId, queue, releaseStaleQueue, () => gate?.uploadHoldChanged())
    const connector = config.writable
      ? createWorkspaceConnector(dbFilenameForUser(user.id), resolver, hold.beforeUploadBatch)
      : undefined
    if (!existing) await connect(db, connector)
    const row = existing ?? await waitForWorkspace(db, workspaceId, signal)
    signal.throwIfAborted()
    await openDeviceWorkspace(config, user.id, parseWorkspaceRow(row))
    if (existing) await connect(db, connector)
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
      hostHealth: async () => {
        const {queuedEntries, oldestQueuedAgeMs} = await readUploadQueue(db)
        return {
          queuedEntries, oldestQueuedAgeMs, uploadHold: hold.isHeld() ? STALE_QUEUE_REASON : null,
          commit, readOnly: active.isReadOnly,
          baselineSyncedAt: baseline ?? null,
          lastSyncedAt: db.currentStatus.lastSyncedAt?.getTime() ?? null,
          closedReason: gate ? gate.reason() : 'Starting gate',
        }
      },
    })
    bridge = await register(config, user, async command => {
      signal.throwIfAborted()
      return executeHeadlessCommand(command, context, async () => {
        if (!gate) return 'Starting gate'
        return gate.readReason()
      })
    })
    const transport = bridge.postEvent
    gate = startReadGate(db, active, workspaceId, baseline, async signal => {
      const namespaces = await openWorkspaceData(active, workspaceId, false, signal)
      await untilStopped(Promise.all(namespaces), signal)
    }, visible => {
      if (visible) {
        releaseBulk?.()
        releaseBulk = undefined
        watchEventsRegistry.setTransport(transport)
      } else {
        watchEventsRegistry.disposeAll()
      }
    }, {writable: config.writable === true, isUploadHeld: hold.isHeld})
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
        // Node schedules idle work with a zero-delay timer. Let already-armed
        // callbacks enter the pending set before asking the Repo to drain it.
        await nextTimerTurn(0)
        await repo.awaitDeferredWork()
        repo.cancelDelayedProcessors()
      }
    }
  }
}

export async function runHost(config: HeadlessConfig, user: User, signal: AbortSignal, releaseStaleQueue = false) {
  if (!hasRemoteSyncConfig) throw new Error('Set VITE_POWERSYNC_URL to run the headless host')
  provideRuntimeGlobals()
  const db = new PowerSyncDatabase({
    schema: createClientPowerSyncSchema(),
    database: {dbLocation: config.stateDir, dbFilename: dbFilenameForUser(user.id), readWorkerCount: 1},
  })
  try {
    await serveDatabase(db, config, user, signal, undefined, undefined, releaseStaleQueue)
  } catch (error) {
    if (!signal.aborted || error !== signal.reason) throw error
  } finally {
    await db.close()
  }
  if (signal.aborted && signal.reason?.name !== 'AbortError') throw signal.reason
}
