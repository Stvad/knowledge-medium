import type { SupabaseClient } from '@supabase/supabase-js'
import { workspaceGateDeps } from '@/components/workspace/WorkspaceKeyGate'
import { notifyWorkspaceUnlocked } from '@/components/workspace/workspaceUnlocked'
import { attachmentCleanerIOVerb, type AttachmentCleanerIOResult } from '@/data/attachmentCleanerIOVerb'
import { WRITE_AHEAD_SIDECAR_SUFFIXES } from '@/data/dbFileSiblings'
import { dbFilenameForUser } from '@/data/localDbStorage'
import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { supabase } from '@/services/supabase'
import type { AttachmentCleanerIO } from '@/sync/conversion/attachmentCleaner'
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
import { exportRawSqliteDbToFile } from '@/utils/exportSqliteDb'
import { queryDirectoryPermission, supportsDirectoryPicker } from '@/utils/fileSystemAccess'
import { holdScreenWakeLock } from '@/utils/screenWakeLock'

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
  // The copy checkpoints first, so pages still in the write-ahead sidecars
  // land in it: counting them too makes this an upper bound.
  localDbBytes: async () => {
    const root = await navigator.storage.getDirectory()
    const dbFilename = dbFilenameForUser(repo.user.id)
    const sizes = await Promise.all(['', ...WRITE_AHEAD_SIDECAR_SUFFIXES].map(suffix =>
      root.getFileHandle(dbFilename + suffix).then(handle => handle.getFile()).then(file => file.size, () => 0)))
    return sizes.reduce((sum, size) => sum + size, 0)
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

const attachmentsOf = (repo: Repo, workspaceId: string): AttachmentCleanerIOResult =>
  repo.facetRuntime
    ? attachmentCleanerIOVerb.runSync(repo.facetRuntime, {repo, workspaceId})
    : {kind: 'unavailable', reason: "the app's extensions haven't loaded"}

/** The run's dependencies, or why this session can't run a conversion. */
export const conversionSetup = (repo: Repo, workspaceId: string, localOnly: boolean): ConversionSetup => {
  const client = supabase
  if (!client || localOnly) return {kind: 'unavailable', why: {kind: 'no-server'}}
  const lock = webConversionLock()
  if (!lock) return {kind: 'unavailable', why: {kind: 'no-web-locks'}}
  const attachments = attachmentsOf(repo, workspaceId)
  if (attachments.kind === 'unavailable') {
    return {kind: 'unavailable', why: {kind: 'no-attachments', reason: attachments.reason}}
  }
  return {
    kind: 'ready',
    makeDeps: (ui, signal) => conversionFlowDeps({repo, workspaceId, client, lock, attachments: attachments.io, ui, signal}),
  }
}

const conversionFlowDeps = ({repo, workspaceId, client, lock, attachments, ui, signal}: {
  repo: Repo
  workspaceId: string
  client: SupabaseClient
  lock: ConversionLock
  attachments: AttachmentCleanerIO
  ui: ConversionUi
  signal: AbortSignal
}): ConversionFlowDeps => ({
  userId: repo.user.id,
  workspaceId,
  server: createSupabaseConversionServer(client, signal),
  fetchConversionState: () => fetchWorkspaceConversionState(workspaceId),
  keyStore: getWorkspaceKeyStore(),
  flipAttempts: localFlipAttempts(repo.user.id, workspaceId),
  lock,
  preflight: preflightEnvironment(repo),
  markLocalConverted: canary => markLocalWorkspaceConverted(repo.db, workspaceId, canary),
  bundles: (bundleRecords ??= new IndexedDbBundleRecordStore()),
  attachments,
  canReadFolder: async folder => (await queryDirectoryPermission(directoryHandleOf(folder), 'read')) === 'granted',
  writeLocalDb: async (folder, signal) => {
    const hasher = createPartHasher()
    await exportRawSqliteDbToFile(repo, await directoryHandleOf(folder).getFileHandle(BUNDLE_PARTS.localDb, {create: true}), {
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
