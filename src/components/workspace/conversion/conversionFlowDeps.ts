import type { SupabaseClient } from '@supabase/supabase-js'
import { workspaceGateDeps } from '@/components/workspace/WorkspaceKeyGate'
import { notifyWorkspaceUnlocked } from '@/components/workspace/workspaceUnlocked'
import { attachmentCleanerIOVerb, type AttachmentCleanerIOResult } from '@/data/attachmentCleanerIOVerb'
import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { supabase } from '@/services/supabase'
import type { ConversionAttachmentsIO } from '@/sync/conversion/conversionAttachments'
import { createPartHasher, type BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import { IndexedDbBundleRecordStore } from '@/sync/conversion/bundle/bundleRecord'
import { BUNDLE_PARTS } from '@/sync/conversion/bundle/manifest'
import { createSupabaseConversionServer } from '@/sync/conversion/conversionServer'
import { localFlipAttempts } from '@/sync/conversion/flipAttempts'
import type { PreflightEnvironment } from '@/sync/conversion/preflight'
import { webConversionLock, type ConversionLock } from '@/sync/conversion/runLock'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { getWorkspaceKeyStore, IndexedDbWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { upgradeWorkspacePin } from '@/sync/keys/flows/upgradeWorkspacePin'
import { canPersistPins } from '@/sync/keys/modePin'
import { abortableSleep } from '@/utils/abortableSleep'
import { exportRawSqliteDbToFile, localDbFileBytes } from '@/utils/exportSqliteDb'
import { queryDirectoryPermission, supportsDirectoryPicker } from '@/utils/fileSystemAccess'
import { holdScreenWakeLock } from '@/utils/screenWakeLock'
import { stoppable, untilStopped } from '@/utils/untilStopped'

/** UI-state and preference writes upload continuously, so a queue that is
 *  momentarily non-empty gets this long to drain before it counts. */
const QUEUE_SETTLE_MS = 10_000
const QUEUE_POLL_MS = 500

const uploadQueue = (repo: Repo) => async (signal?: AbortSignal): Promise<{pending: number; rejected: number}> => {
  const read = () => repo.db.get<{pending: number; rejected: number}>(
    'SELECT (SELECT COUNT(*) FROM ps_crud) AS pending, (SELECT COUNT(*) FROM ps_crud_rejected) AS rejected',
  )
  const deadline = Date.now() + QUEUE_SETTLE_MS
  for (let queue = await read(); ; queue = await read()) {
    if (queue.pending === 0 || Date.now() >= deadline) return queue
    await abortableSleep(QUEUE_POLL_MS, signal)
  }
}

const preflightEnvironment = (repo: Repo): PreflightEnvironment => ({
  canPersistPins,
  keyStoreIsDurable: getWorkspaceKeyStore() instanceof IndexedDbWorkspaceKeyStore,
  supportsDirectoryPicker: supportsDirectoryPicker(),
  uploadQueue: uploadQueue(repo),
  localDbBytes: () => localDbFileBytes(repo.user.id),
  freeLocalBytes: async () => {
    const {quota, usage} = await navigator.storage.estimate().catch(() => ({quota: undefined, usage: undefined}))
    return quota === undefined || usage === undefined ? null : Math.max(0, quota - usage)
  },
})

export type ConversionUnavailable =
  /** Not signed in to a server: local-only, or none configured. */
  | {readonly kind: 'no-server'}
  /** Without Web Locks, a second tab can't be kept out of the run. */
  | {readonly kind: 'no-web-locks'}
  /** Without the attachments plugin's Storage access the folder can't be
   *  proved clean, so the conversion could never finish. */
  | {readonly kind: 'no-attachments'; readonly reason: string}

export type ConversionSetup =
  | {readonly kind: 'ready'; readonly makeDeps: (ui: ConversionUi, signal: AbortSignal) => ConversionFlowDeps}
  | {readonly kind: 'unavailable'; readonly why: ConversionUnavailable}

let bundleRecords: IndexedDbBundleRecordStore | null = null

/** The slowest folder the database copy waits for: a USB 2 stick or a slow
 *  network share, in bytes a second. */
const SLOWEST_BUNDLE_DISK = 5 * 1024 * 1024

/** In the browser every bundle folder is a `FileSystemDirectoryHandle`: the
 *  picker made it, or IndexedDB stored one. */
export const directoryHandleOf = (folder: BundleFolder): FileSystemDirectoryHandle =>
  folder as unknown as FileSystemDirectoryHandle

const attachmentsOf = async (repo: Repo, workspaceId: string): Promise<AttachmentCleanerIOResult> => {
  if (!repo.facetRuntime) return {kind: 'unavailable', reason: "the app's extensions haven't loaded"}
  try {
    return await attachmentCleanerIOVerb.run(repo.facetRuntime, {repo, workspaceId})
  } catch (error) {
    return {kind: 'unavailable', reason: error instanceof Error ? error.message : String(error)}
  }
}

/** The run's dependencies, or why this session can't run a conversion. */
export const conversionSetup = async (repo: Repo, workspaceId: string, localOnly: boolean): Promise<ConversionSetup> => {
  const client = supabase
  if (!client || localOnly) return {kind: 'unavailable', why: {kind: 'no-server'}}
  const lock = webConversionLock()
  if (!lock) return {kind: 'unavailable', why: {kind: 'no-web-locks'}}
  const attachments = await attachmentsOf(repo, workspaceId)
  if (attachments.kind === 'unavailable') {
    return {kind: 'unavailable', why: {kind: 'no-attachments', reason: attachments.reason}}
  }
  return {
    kind: 'ready',
    makeDeps: (ui, signal) => conversionFlowDeps({repo, workspaceId, client, lock, attachments: attachments.io, ui, signal}),
  }
}

/** Every dependency that waits on the network is bound to the run's `signal`
 *  here, so Stop reaches each call: the server's requests abort, the rest race
 *  it. A raced call is abandoned, not cancelled, so a Storage delete also aborts
 *  itself (`deleteObject`'s signal); an abandoned upload is harmless, since the
 *  first write at a keyed name wins and the cleaner verifies what is there. The
 *  bundle folder, which the user picks mid-run, is bound where it's used
 *  (`stoppableFolder`). */
const conversionFlowDeps = ({repo, workspaceId, client, lock, attachments, ui, signal}: {
  repo: Repo
  workspaceId: string
  client: SupabaseClient
  lock: ConversionLock
  attachments: ConversionAttachmentsIO
  ui: ConversionUi
  signal: AbortSignal
}): ConversionFlowDeps => ({
  userId: repo.user.id,
  workspaceId,
  server: createSupabaseConversionServer(client, signal),
  fetchConversionState: () => untilStopped(fetchWorkspaceConversionState(workspaceId), signal),
  keyStore: getWorkspaceKeyStore(),
  flipAttempts: localFlipAttempts(repo.user.id, workspaceId),
  lock,
  preflight: preflightEnvironment(repo),
  markLocalConverted: canary => markLocalWorkspaceConverted(repo.db, workspaceId, canary),
  bundles: (bundleRecords ??= new IndexedDbBundleRecordStore()),
  attachments: stoppable(attachments, signal),
  canReadFolder: async folder => (await queryDirectoryPermission(directoryHandleOf(folder), 'read')) === 'granted',
  writeLocalDb: async (folder, signal) => {
    const hasher = createPartHasher()
    const file = await untilStopped(directoryHandleOf(folder).getFileHandle(BUNDLE_PARTS.localDb, {create: true}), signal)
    await exportRawSqliteDbToFile(repo, file, {
      timeoutMessage:
        "Copying this device's database into the recovery bundle took too long. Pick a folder on a faster disk, then try again.",
      minBytesPerSecond: SLOWEST_BUNDLE_DISK,
      onChunk: chunk => hasher.update(chunk),
      signal,
    })
    return hasher.digest()
  },
  keepAwake: holdScreenWakeLock,
  upgradePin: async () => {
    const result = await upgradeWorkspacePin({
      userId: repo.user.id,
      workspaceId,
      ...workspaceGateDeps(repo, workspaceId),
      key: {kind: 'stored'},
      keyStore: getWorkspaceKeyStore(),
    })
    if (result.ok) notifyWorkspaceUnlocked(workspaceId)
    return result
  },
  ui,
  signal,
})
