import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { supabase } from '@/services/supabase'
import { createSupabaseConversionServer } from '@/sync/conversion/conversionServer'
import type { PreflightEnvironment } from '@/sync/conversion/preflight'
import { webConversionLock } from '@/sync/conversion/runLock'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { getWorkspaceKeyStore, IndexedDbWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { canPersistPins } from '@/sync/keys/modePin'

/** UI-state and preference writes upload continuously, so a queue that is
 *  momentarily non-empty gets this long to drain before it counts. */
const QUEUE_SETTLE_MS = 10_000
const QUEUE_POLL_MS = 500

const uploadQueue = (repo: Repo) => async (): Promise<{pending: number; rejected: number}> => {
  const read = () => repo.db.get<{pending: number; rejected: number}>(
    'SELECT (SELECT COUNT(*) FROM ps_crud) AS pending, (SELECT COUNT(*) FROM ps_crud_rejected) AS rejected',
  )
  const deadline = Date.now() + QUEUE_SETTLE_MS
  for (let queue = await read(); ; queue = await read()) {
    if (queue.pending === 0 || Date.now() >= deadline) return queue
    await new Promise(resolve => setTimeout(resolve, QUEUE_POLL_MS))
  }
}

const preflightEnvironment = (repo: Repo): PreflightEnvironment => ({
  canPersistPins,
  keyStoreIsDurable: getWorkspaceKeyStore() instanceof IndexedDbWorkspaceKeyStore,
  supportsDirectoryPicker: typeof (globalThis as {showDirectoryPicker?: unknown}).showDirectoryPicker === 'function',
  uploadQueue: uploadQueue(repo),
})

export type ConversionUnavailable = 'no-server' | 'no-web-locks'

export const conversionFlowDeps = (
  repo: Repo,
  workspaceId: string,
  ui: ConversionUi,
  signal: AbortSignal,
): ConversionFlowDeps | ConversionUnavailable => {
  if (!supabase) return 'no-server'
  const lock = webConversionLock()
  if (!lock) return 'no-web-locks'
  return {
    userId: repo.user.id,
    workspaceId,
    server: createSupabaseConversionServer(supabase),
    fetchConversionState: () => fetchWorkspaceConversionState(workspaceId),
    keyStore: getWorkspaceKeyStore(),
    lock,
    preflight: preflightEnvironment(repo),
    markLocalConverted: canary => markLocalWorkspaceConverted(repo.db, workspaceId, canary),
    ui,
    signal,
  }
}
