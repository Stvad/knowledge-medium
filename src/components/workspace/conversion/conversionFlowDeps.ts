import { workspaceGateDeps } from '@/components/workspace/WorkspaceKeyGate'
import { notifyWorkspaceUnlocked } from '@/components/workspace/workspaceUnlocked'
import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { supabase } from '@/services/supabase'
import { createPartHasher, type BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import { IndexedDbBundleRecordStore } from '@/sync/conversion/bundle/bundleRecord'
import { BUNDLE_PARTS } from '@/sync/conversion/bundle/manifest'
import { createSupabaseConversionServer } from '@/sync/conversion/conversionServer'
import { localFlipAttempts } from '@/sync/conversion/flipAttempts'
import type { PreflightEnvironment } from '@/sync/conversion/preflight'
import { webConversionLock } from '@/sync/conversion/runLock'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { getWorkspaceKeyStore, IndexedDbWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { upgradeWorkspacePin } from '@/sync/keys/flows/upgradeWorkspacePin'
import { canPersistPins } from '@/sync/keys/modePin'
import { abortableSleep } from '@/utils/abortableSleep'
import { exportRawSqliteDbToFile, localDbFileBytes } from '@/utils/exportSqliteDb'
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
  localDbBytes: () => localDbFileBytes(repo.user.id),
})

export type ConversionUnavailable =
  /** Not signed in to a server: local-only, or none configured. */
  | 'no-server'
  /** Without Web Locks, a second tab can't be kept out of the run. */
  | 'no-web-locks'

export const conversionUnavailable = (localOnly: boolean): ConversionUnavailable | null => {
  if (!supabase || localOnly) return 'no-server'
  if (!webConversionLock()) return 'no-web-locks'
  return null
}

let bundleRecords: IndexedDbBundleRecordStore | null = null

/** The slowest folder the database copy waits for: a USB 2 stick or a slow
 *  network share, in bytes a second. */
const SLOWEST_BUNDLE_DISK = 5 * 1024 * 1024

/** In the browser every bundle folder is a `FileSystemDirectoryHandle`: the
 *  picker made it, or IndexedDB stored one. */
export const directoryHandleOf = (folder: BundleFolder): FileSystemDirectoryHandle =>
  folder as unknown as FileSystemDirectoryHandle

/** Call only once {@link conversionUnavailable} has returned null. */
export const conversionFlowDeps = (
  repo: Repo,
  workspaceId: string,
  ui: ConversionUi,
  signal: AbortSignal,
): ConversionFlowDeps => {
  const lock = webConversionLock()
  if (!supabase || !lock) throw new Error('conversion: this session cannot run a conversion')
  return {
    userId: repo.user.id,
    workspaceId,
    server: createSupabaseConversionServer(supabase, signal),
    fetchConversionState: () => fetchWorkspaceConversionState(workspaceId),
    keyStore: getWorkspaceKeyStore(),
    flipAttempts: localFlipAttempts(repo.user.id, workspaceId),
    lock,
    preflight: preflightEnvironment(repo),
    markLocalConverted: canary => markLocalWorkspaceConverted(repo.db, workspaceId, canary),
    bundles: (bundleRecords ??= new IndexedDbBundleRecordStore()),
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
  }
}
