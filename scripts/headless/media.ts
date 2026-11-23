import {join} from 'node:path'
import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {SupabaseClient} from '@supabase/supabase-js'
import type {Repo} from '@/data/repo'
import {fetchWorkspaceConversionState} from '@/data/workspaceConversion'
import type {AgentMedia} from '@/plugins/agent-runtime/protocol'
import {createSupabaseBlobStore, NO_REMOTE_BLOB_STORE} from '@/plugins/attachments/blobStore'
import {createMediaLanes, type MediaLaneDeps} from '@/plugins/attachments/mediaLanes'
import {SqliteByteUploadStore} from '@/plugins/attachments/uploadStore'
import {FsByteStore} from './byteStore'

/** Under the state directory: the plaintext bytes this host captured or read. A
 *  capture's bytes are its only copy until the upload lands. */
export const MEDIA_DIR = 'media'
/** Retries what a drain left pending (offline, an expired session, a held host). */
const MEDIA_DRAIN_INTERVAL_MS = 5 * 60 * 1000

/** What the host's media lanes reach beyond the device. */
export type HostMediaRemote = Pick<MediaLaneDeps, 'blobStore' | 'readLiveWorkspace'>

/** `client` is the app's signed-in singleton, which the live mode read also uses. */
export const supabaseMediaRemote = (client: SupabaseClient): HostMediaRemote => ({
  blobStore: createSupabaseBlobStore({
    client,
    getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
  }),
  readLiveWorkspace: workspaceId => fetchWorkspaceConversionState(workspaceId),
})

/** For a host started without one: reads miss, and uploads stay pending. */
export const NO_MEDIA_REMOTE: HostMediaRemote = {
  blobStore: NO_REMOTE_BLOB_STORE,
  readLiveWorkspace: async () => ({kind: 'unavailable', error: new Error('This host has no media remote')}),
}

export interface HostMediaOptions extends HostMediaRemote {
  db: CommonPowerSyncDatabase
  stateDir: string
  userId: string
  keys: MediaLaneDeps['keys']
  /** The host's write refusal (`gate.writeRefusal`): uploads wait while it has one. */
  writeRefusal: () => string | null
}

/** Media for one host: bytes in its state directory, the upload queue in its
 *  database. Uploads run from the first gate open until `stop`, while the host may write. */
export function openHostMedia({db, stateDir, userId, keys, writeRefusal, ...remote}: HostMediaOptions) {
  const lanes = createMediaLanes({
    userId, keys, ...remote,
    byteStore: new FsByteStore(join(stateDir, MEDIA_DIR)),
    uploadStore: new SqliteByteUploadStore(db),
    canDrain: () => writeRefusal() === null,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let reconciling: Promise<void> | undefined
  // The tab's Attachments toggle lives in its app runtime, which a host does not run.
  const agent: AgentMedia = {captureRefusal: () => null, resolve: lanes.resolver.resolve, capture: lanes.capture}
  return {
    agent,
    health: lanes.counts,
    start(repo: Pick<Repo, 'load'>) {
      if (timer) return
      reconciling = lanes.reconcile(repo).then(lanes.drain).catch(error => console.warn('[headless media] reconcile failed', error))
      timer = setInterval(() => void lanes.drain(), MEDIA_DRAIN_INTERVAL_MS)
      timer.unref()
    },
    /** Lets the boot reconcile and the drain pass in flight finish, so their queue
     *  updates reach the database before it closes. A pass can take as long as its
     *  uploads; the supervisor's stop timeout bounds that, and a killed pass leaves its
     *  records pending for the next process. */
    async stop() {
      clearInterval(timer)
      await reconciling
      await lanes.settled()
    },
  }
}
