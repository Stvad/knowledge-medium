/*
 * Device-local settings and status for the database mirror.
 *
 * IndexedDB, not a block: the folder is a `FileSystemDirectoryHandle`, a
 * host object that only means anything on the machine that granted it, and
 * IndexedDB is what SURVIVED the OPFS wipe this feature exists for. The rest of
 * the state sits beside it for the same reason — a mirror's cadence and history
 * describe one device's copy on one disk, and syncing them would have a phone
 * that cannot mirror at all reporting a laptop's last run.
 *
 * The handle lives under its own key, so the settings record stays plain JSON:
 * a browser that fails to clone the handle loses the folder, not the settings.
 *
 * Records are namespaced by the DATABASE FILENAME rather than by the user id,
 * because that is what the state describes. A PR preview and production are the
 * same origin and the same account but deliberately different SQLite files
 * (`dbFilenameForUser`), each with its own `row_events` counter — keyed by user
 * alone they would overwrite each other's change marker, and one of them would
 * skip a run it needed to make.
 */
import {IdbKeyedStore, idbRecordId, promisifyRequest} from '@/utils/idbKeyedStore.js'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import {CallbackSet} from '@/utils/callbackSet.js'

export interface DbMirrorSettings {
  /** Off until the user turns it on. */
  enabled: boolean
  /** Copies kept in the folder, counting the newest. */
  keepCount: number
  /** Wall clock between runs; each run still waits for a genuine idle window. */
  intervalMinutes: number
}

export interface DbMirrorStatus {
  /** Change marker of the last copy written, for the skip-when-unchanged test. */
  lastMarker?: string
  lastMirrorAt?: number
  /** When a run last COMPLETED, mirrored or skipped. Tells "nothing has
   *  changed since the last copy" apart from "the mirror has stalled". */
  lastCheckedAt?: number
  lastFilename?: string
  lastBytes?: number
  /** The folder grant lapsed. Only a user gesture can clear this, so the
   *  scheduled runs stop until the settings surface asks again. */
  permissionLost?: boolean
  lastError?: string
  lastErrorAt?: number
}

export interface DbMirrorState {
  settings: DbMirrorSettings
  status: DbMirrorStatus
  directory?: FileSystemDirectoryHandle
}

export const DB_MIRROR_DEFAULTS: DbMirrorSettings = {
  enabled: false,
  keepCount: 3,
  intervalMinutes: 60,
}

export const MIN_KEEP_COUNT = 1
export const MAX_KEEP_COUNT = 20
export const MIN_INTERVAL_MINUTES = 15
/** A week. Past this the setting is indistinguishable from "off". */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback

/** Answers for a hand-edited or half-written record as well as for our own
 *  writes — this is the only place a stored value becomes a setting. */
export const normalizeSettings = (value: unknown): DbMirrorSettings => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<DbMirrorSettings>
  return {
    enabled: raw.enabled === true,
    keepCount: clamp(Number(raw.keepCount), MIN_KEEP_COUNT, MAX_KEEP_COUNT, DB_MIRROR_DEFAULTS.keepCount),
    intervalMinutes: clamp(
      Number(raw.intervalMinutes),
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES,
      DB_MIRROR_DEFAULTS.intervalMinutes,
    ),
  }
}

const normalizeStatus = (value: unknown): DbMirrorStatus => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as DbMirrorStatus
  return dropUndefined({
    lastMarker: typeof raw.lastMarker === 'string' ? raw.lastMarker : undefined,
    lastMirrorAt: typeof raw.lastMirrorAt === 'number' ? raw.lastMirrorAt : undefined,
    lastCheckedAt: typeof raw.lastCheckedAt === 'number' ? raw.lastCheckedAt : undefined,
    lastFilename: typeof raw.lastFilename === 'string' ? raw.lastFilename : undefined,
    lastBytes: typeof raw.lastBytes === 'number' ? raw.lastBytes : undefined,
    permissionLost: typeof raw.permissionLost === 'boolean' ? raw.permissionLost : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    lastErrorAt: typeof raw.lastErrorAt === 'number' ? raw.lastErrorAt : undefined,
  })
}

/** Keeps an explicit `undefined` in a patch meaning "clear this" without
 *  leaving the key behind for `toEqual` — and out of IndexedDB. */
const dropUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

const SETTINGS_KEY = 'settings'
const DIRECTORY_KEY = 'directory'

/** Record ids for the database this user has ON THIS DEPLOYMENT. */
const keysFor = (userId: string) => {
  const namespace = dbFilenameForUser(userId)
  return {
    settings: idbRecordId(namespace, SETTINGS_KEY),
    directory: idbRecordId(namespace, DIRECTORY_KEY),
  }
}

export interface DbMirrorStore {
  /** Read this user's state from storage into the snapshot. */
  load: (userId: string) => Promise<DbMirrorState>
  updateSettings: (userId: string, patch: Partial<DbMirrorSettings>) => Promise<DbMirrorState>
  setDirectory: (userId: string, directory: FileSystemDirectoryHandle | undefined) => Promise<DbMirrorState>
  recordStatus: (userId: string, patch: DbMirrorStatus) => Promise<DbMirrorState>
  /** The last loaded state, or null before the first load. Referentially
   *  stable while unchanged, for `useSyncExternalStore`. */
  getSnapshot: () => DbMirrorState | null
  subscribe: (listener: () => void) => () => void
}

export const createDbMirrorStore = (dbName = 'km-db-mirror'): DbMirrorStore => {
  const idb = new IdbKeyedStore(dbName, 'mirror')
  const listeners = new CallbackSet('db-mirror-store')
  let snapshot: DbMirrorState | null = null
  let snapshotUserId: string | null = null
  // Other tabs write the same records and nothing in IndexedDB says so. Without
  // this a settings dialog left open, and the status chip, would go on showing
  // a healthy mirror after a background tab recorded a failure — which is the
  // exact thing this feature exists to report.
  const channel =
    typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${dbName}:changed`) : null

  const publish = (userId: string, state: DbMirrorState): DbMirrorState => {
    // A late-finishing operation for a user who has since been replaced —
    // local-only sign-out swaps accounts without a reload — must not put the
    // previous account's folder and history back on screen. The already-mounted
    // dialog would never reload it: its effect keys on the CURRENT user id,
    // which has not changed since it mounted.
    if (snapshotUserId !== userId) return state
    snapshot = state
    listeners.notify()
    return state
  }

  /**
   * Read the stored state, apply `mutate`, and write it back — all inside ONE
   * IndexedDB transaction, which is what makes it safe against a second tab.
   * A read and a write in separate transactions can interleave with another
   * tab's pair, and the later whole-record write then silently reverts the
   * settings change the user just made in the other tab.
   *
   * `mutate` is therefore SYNCHRONOUS: an await inside it would yield to a
   * later task and the transaction would auto-commit out from under it (see the
   * activeness contract in `idbKeyedStore`).
   */
  const update = (
    userId: string,
    mutate: (state: DbMirrorState) => DbMirrorState,
    persist = true,
  ): Promise<DbMirrorState> => {
    const keys = keysFor(userId)
    return idb
      .runTransaction(persist ? 'readwrite' : 'readonly', async store => {
        const record = (await promisifyRequest(store.get(keys.settings))) as
          | {settings?: unknown; status?: unknown}
          | undefined
        const directory = (await promisifyRequest(store.get(keys.directory))) as
          | FileSystemDirectoryHandle
          | undefined
        const updated = mutate({
          settings: normalizeSettings(record?.settings),
          status: normalizeStatus(record?.status),
          directory: directory ?? undefined,
        })
        if (persist) {
          store.put({settings: updated.settings, status: updated.status}, keys.settings)
          if (updated.directory) store.put(updated.directory, keys.directory)
          else store.delete(keys.directory)
        }
        return updated
      })
      .then(updated => {
        if (persist) channel?.postMessage(userId)
        return publish(userId, updated)
      })
      .catch((err: unknown) => {
        // Blocked or absent storage (a private window, a browser with site data
        // off). Answering with the defaults keeps the app working; mirroring is
        // simply off, which is what "no stored opt-in" means anyway.
        console.warn('[db-mirror] could not read or save settings', err)
        return publish(userId, {settings: {...DB_MIRROR_DEFAULTS}, status: {}, directory: undefined})
      })
  }

  const reload = (): void => {
    if (snapshotUserId !== null) void update(snapshotUserId, state => state, false)
  }
  if (channel) channel.onmessage = (event) => { if (event.data === snapshotUserId) reload() }

  return {
    load: (userId) => {
      // A different account than the snapshot describes: drop it NOW rather
      // than when the read resolves, so nothing reads the previous user's
      // folder and history in between.
      if (snapshotUserId !== userId) {
        snapshot = null
        snapshotUserId = userId
        listeners.notify()
      }
      // Read-only: the scheduled loop reads this on every tick, and writing the
      // record back each time would churn storage and mint a record for a user
      // who never opted in.
      return update(userId, state => state, false)
    },
    updateSettings: (userId, patch) =>
      update(userId, state => ({
        ...state,
        settings: normalizeSettings({...state.settings, ...patch}),
      })),
    recordStatus: (userId, patch) =>
      update(userId, state => ({
        ...state,
        status: normalizeStatus({...state.status, ...patch}),
      })),
    setDirectory: (userId, directory) =>
      update(userId, state => ({
        ...state,
        directory,
        // The whole status describes copies in the folder being replaced: its
        // change marker, its last filename, its failure. Carrying the MARKER
        // across in particular would have the next run report
        // "skipped-unchanged" while the newly chosen folder stayed empty and the
        // status chip called the mirror healthy.
        status: {},
      })),
    getSnapshot: () => snapshot,
    subscribe: (listener) => listeners.add(listener),
  }
}

/** The app's single store. Tests build their own with `createDbMirrorStore`. */
export const dbMirrorStore = createDbMirrorStore()
