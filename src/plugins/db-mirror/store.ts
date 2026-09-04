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
 */
import {IdbKeyedStore, idbRecordId} from '@/utils/idbKeyedStore.js'
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
  // Every write is a read-modify-write of the same two records, so they run one
  // at a time: two overlapping updates would otherwise each persist their own
  // view of the record and the later one would drop the earlier's field.
  let queue: Promise<unknown> = Promise.resolve()

  const publish = (userId: string, state: DbMirrorState): DbMirrorState => {
    snapshot = state
    snapshotUserId = userId
    listeners.notify()
    return state
  }

  const readState = async (userId: string): Promise<DbMirrorState> => {
    try {
      const [record, directory] = await Promise.all([
        idb.tx('readonly', store => store.get(idbRecordId(userId, SETTINGS_KEY))),
        idb.tx('readonly', store => store.get(idbRecordId(userId, DIRECTORY_KEY))),
      ])
      const stored = record as {settings?: unknown; status?: unknown} | undefined
      return {
        settings: normalizeSettings(stored?.settings),
        status: normalizeStatus(stored?.status),
        directory: (directory as FileSystemDirectoryHandle | undefined) ?? undefined,
      }
    } catch (err) {
      // Blocked or absent storage (a private window, a browser with site data
      // off). Answering with the defaults keeps the app working; mirroring is
      // simply off, which is what "no stored opt-in" means anyway.
      console.warn('[db-mirror] could not read settings; using defaults', err)
      return {settings: {...DB_MIRROR_DEFAULTS}, status: {}, directory: undefined}
    }
  }

  const writeRecord = async (userId: string, state: DbMirrorState): Promise<void> => {
    await idb.tx('readwrite', store =>
      store.put({settings: state.settings, status: state.status}, idbRecordId(userId, SETTINGS_KEY)),
    )
  }

  /** Serialised read-modify-write. `mutate` sees storage as it stands, not the
   *  snapshot — another tab writes the same records. */
  const update = (
    userId: string,
    mutate: (state: DbMirrorState) => Promise<DbMirrorState> | DbMirrorState,
  ): Promise<DbMirrorState> => {
    const next = queue.then(async () => {
      const current = await readState(userId)
      const updated = await mutate(current)
      try {
        await writeRecord(userId, updated)
      } catch (err) {
        console.warn('[db-mirror] could not save settings', err)
      }
      return publish(userId, updated)
    })
    queue = next.catch(() => {})
    return next
  }

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
      return update(userId, state => state)
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
      update(userId, async state => {
        const key = idbRecordId(userId, DIRECTORY_KEY)
        try {
          if (directory) await idb.tx('readwrite', store => store.put(directory, key))
          else await idb.tx('readwrite', store => store.delete(key))
        } catch (err) {
          console.warn('[db-mirror] could not save the chosen folder', err)
        }
        return {...state, directory}
      }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => listeners.add(listener),
  }
}

/** The app's single store. Tests build their own with `createDbMirrorStore`. */
export const dbMirrorStore = createDbMirrorStore()
