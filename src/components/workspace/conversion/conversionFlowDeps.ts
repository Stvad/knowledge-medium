import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { supabase } from '@/services/supabase'
import { createSupabaseConversionServer } from '@/sync/conversion/conversionServer'
import { localFlipAttempts } from '@/sync/conversion/flipAttempts'
import type { PreflightEnvironment } from '@/sync/conversion/preflight'
import { webConversionLock } from '@/sync/conversion/runLock'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { getWorkspaceKeyStore, IndexedDbWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { canPersistPins } from '@/sync/keys/modePin'
import { abortableSleep } from '@/utils/abortableSleep'

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

const supportsDirectoryPicker = (): boolean =>
  typeof (globalThis as {showDirectoryPicker?: unknown}).showDirectoryPicker === 'function'

const preflightEnvironment = (repo: Repo): PreflightEnvironment => ({
  canPersistPins,
  keyStoreIsDurable: getWorkspaceKeyStore() instanceof IndexedDbWorkspaceKeyStore,
  supportsDirectoryPicker: supportsDirectoryPicker(),
  uploadQueue: uploadQueue(repo),
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
    ui,
    signal,
  }
}
