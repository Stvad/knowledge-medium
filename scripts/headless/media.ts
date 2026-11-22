import {join} from 'node:path'
import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {SupabaseClient} from '@supabase/supabase-js'
import type {Repo} from '@/data/repo'
import {fetchWorkspaceConversionState} from '@/data/workspaceConversion'
import type {AgentMedia} from '@/plugins/agent-runtime/protocol'
import {createSupabaseBlobStore, type BlobStore} from '@/plugins/attachments/blobStore'
import {createMediaLanes, type MediaLaneDeps} from '@/plugins/attachments/mediaLanes'
import {SqliteByteUploadStore} from '@/plugins/attachments/uploadStore'
import {FsByteStore} from './byteStore'

/** Under the state directory: the plaintext asset bytes this host captured or read. */
export const MEDIA_DIR = 'media'
/** Retries what a drain left pending (offline, an expired session, a locked key). */
export const MEDIA_DRAIN_INTERVAL_MS = 5 * 60 * 1000

/** What the host's media lanes reach beyond the device. */
export type HostMediaRemote = Pick<MediaLaneDeps, 'blobStore' | 'readLiveWorkspace'>

export const supabaseMediaRemote = (client: SupabaseClient): HostMediaRemote => ({
  blobStore: createSupabaseBlobStore({
    client,
    getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
  }),
  readLiveWorkspace: workspaceId => fetchWorkspaceConversionState(workspaceId),
})

const unreachable = (): never => { throw new Error('This host has no media remote') }
/** For a host started without one: reads miss, and uploads stay pending. */
export const NO_MEDIA_REMOTE: HostMediaRemote = {
  blobStore: {put: unreachable, get: unreachable, probe: unreachable, delete: unreachable} satisfies BlobStore,
  readLiveWorkspace: unreachable,
}

/** Media for one host: bytes in its state directory, the upload queue in its database.
 *  Uploads run only on a writable host, from the first gate open until `stop`. */
export function openHostMedia(
  db: CommonPowerSyncDatabase, stateDir: string, userId: string, writable: boolean,
  keys: MediaLaneDeps['keys'], remote: HostMediaRemote,
) {
  const lanes = createMediaLanes({
    userId, keys, ...remote,
    byteStore: new FsByteStore(join(stateDir, MEDIA_DIR)),
    uploadStore: new SqliteByteUploadStore(db),
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let reconciling: Promise<void> | undefined
  let stopped = false
  const agent: AgentMedia = {captureRefusal: () => null, resolve: lanes.resolver.resolve, capture: lanes.capture}
  return {
    agent,
    health: lanes.counts,
    start(repo: Pick<Repo, 'load'>) {
      if (!writable || stopped || timer) return
      reconciling = lanes.reconcile(repo).catch(error => console.warn('[headless media] reconcile failed', error))
      timer = setInterval(() => void lanes.drain(), MEDIA_DRAIN_INTERVAL_MS)
      timer.unref()
    },
    /** Lets the boot reconcile and an upload in flight finish, so their queue
     *  updates reach the database before it closes. */
    async stop() {
      stopped = true
      clearInterval(timer)
      await reconciling
      await lanes.settled()
    },
  }
}

export type HostMedia = ReturnType<typeof openHostMedia>
