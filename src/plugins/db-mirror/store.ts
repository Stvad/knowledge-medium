/*
 * Device-local settings and status for the database mirror.
 *
 * IndexedDB, not a block: the folder is a `FileSystemDirectoryHandle`, a host
 * object that only means anything on the machine that granted it. The rest of
 * the state sits beside it because a mirror's cadence and history describe one
 * device's copy on one disk, and syncing them would have a phone that cannot
 * mirror at all reporting a laptop's last run.
 *
 * This survives the OPFS-only wipe, which is the common shape. It does NOT
 * survive an eviction of the whole origin bucket — IndexedDB, OPFS and the
 * Cache API share one (see `docs/storage-persistence.md`) — and there is no
 * signal left afterwards to recover from in-app: mirroring comes back off, with
 * the folder unchosen, and every copy already written becomes unmanaged. The
 * settings surface says so rather than pretending otherwise.
 *
 * The handle lives under its own key, so the settings record stays plain JSON:
 * a browser that fails to clone the handle loses the folder, not the settings.
 *
 * Records are namespaced by the DEPLOYMENT and the account — a PR preview and
 * production share an origin but must not share a folder or an opt-in — and
 * deliberately NOT by the database filename, which carries a storage version
 * (`kmp-v6-…`) that is meant to change. Keying on it would have the next VFS
 * bump silently return an opted-in user to off, with their chosen folder
 * unreachable.
 *
 * What IS per-database is the status, so it carries the identity of the
 * database it describes and is disregarded when that no longer matches. That
 * one field is what keeps a replaced database — an import, or a browser wipe
 * the app recovered from — from inheriting the previous one's change marker and
 * concluding there is nothing to copy.
 */
import {IdbKeyedStore, idbRecordId, promisifyRequest} from '@/utils/idbKeyedStore.js'
import {INSTALL_ID_PATTERN} from './filenames.js'
import {previewDbId} from '@/data/localDbStorage.js'
import {CallbackSet} from '@/utils/callbackSet.js'

export interface DbMirrorSettings {
  /** Off until the user turns it on. */
  enabled: boolean
  /** Copies kept in the folder, counting the newest. */
  keepCount: number
  /** Wall clock between runs; each run still waits for a genuine idle window. */
  intervalMinutes: number
}

/** What a run concluded about the database and the folder. Narrow rather than
 *  `string`, so a reader branching on a literal — `schedule.ts` on `'failed'`,
 *  `diagnostics.ts` on `'no-identity'` — is a compile error when it mistypes
 *  one, instead of a branch that silently never runs. */
export type DbMirrorVerdict =
  | 'mirrored'
  | 'skipped-unchanged'
  | 'permission-lost'
  | 'no-identity'
  | 'failed'

const VERDICTS = new Set<string>([
  'mirrored', 'skipped-unchanged', 'permission-lost', 'no-identity', 'failed',
])

export interface DbMirrorStatus {
  /** Change marker of the last copy written, for the skip-when-unchanged test. */
  lastMarker?: string
  lastMirrorAt?: number
  /** When a run last COMPLETED — mirrored, or skipped because the copy it
   *  named was verified present. Tells "nothing has changed since the last
   *  copy" apart from "the mirror has stalled", and it is what the device-wide
   *  cadence gate reads.
   *
   *  ONLY those two outcomes may write it. A run that threw, lost the folder
   *  permission, or could not identify the database completed no check, and
   *  stamping it there makes the gate cancel the retry that run just asked
   *  for — which silently flattens the failure backoff and defers a re-granted
   *  folder for a whole interval. */
  lastCheckedAt?: number
  lastFilename?: string
  /** How many bytes that copy has, so a later run can tell an intact file from
   *  one an interrupted sync truncated. */
  lastBytes?: number
  /** The folder grant lapsed. Runs keep checking on the ordinary cadence and
   *  clear this by themselves once it is back; only the settings surface can
   *  ASK for it again. */
  permissionLost?: boolean
  /** Copies in the folder that the keep count does not govern — see `survey`
   *  in `mirror.ts` for which those are. Recorded so a folder holding more
   *  files than the user asked for has a reason they can see. */
  unmanagedCopies?: number
  /** What the last run that reached a conclusion concluded, and when.
   *
   *  Unlike {@link lastCheckedAt} this is written by EVERY terminal outcome,
   *  including the ones that produced no copy. It is what lets the chip report
   *  the run's own verdict instead of inferring one from the fields below —
   *  inference is how a mirror that refuses every run came to look identical
   *  to one waiting for its first idle moment. */
  lastOutcome?: DbMirrorVerdict
  lastOutcomeAt?: number
  /** Which database the fields above describe (see `readDatabaseIncarnation`).
   *  A status whose incarnation is not the current one says nothing about the
   *  database now in front of us. */
  incarnation?: string
  lastError?: string
  lastErrorAt?: number
}

export interface DbMirrorState {
  settings: DbMirrorSettings
  status: DbMirrorStatus
  directory?: FileSystemDirectoryHandle
  /** This INSTALL, minted on the first write and never copied.
   *
   *  Deliberately outside the database: restoring a mirror onto a second device
   *  copies the database wholesale, so anything stored inside it identifies the
   *  data rather than the machine holding it. Two installs sharing a cloud
   *  folder must not prune each other's copies, and this is what tells them
   *  apart. Undefined until something has been saved. */
  installId?: string
  /** Bumped every time the folder changes. A run captures it and records its
   *  result only if it still matches, because a run is not instantaneous: a
   *  copy into the OLD folder that lands after the user has picked a new one
   *  would otherwise write a fresh `lastCheckedAt`, and the device-wide cadence
   *  gate would defer the first copy into the new folder for a whole interval —
   *  a week at the longest setting — with nothing reporting it. */
  directoryEpoch?: number
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
const normalizeSettings = (value: unknown): DbMirrorSettings => {
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

/** Same job as {@link normalizeSettings}, and the same rule about finiteness:
 *  this is the only place a stored value becomes a status, so `NaN` stops here
 *  rather than reaching readers that each answer it differently. */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const normalizeStatus = (value: unknown): DbMirrorStatus => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as DbMirrorStatus
  return dropUndefined({
    lastMarker: typeof raw.lastMarker === 'string' ? raw.lastMarker : undefined,
    lastMirrorAt: isFiniteNumber(raw.lastMirrorAt) ? raw.lastMirrorAt : undefined,
    lastCheckedAt: isFiniteNumber(raw.lastCheckedAt) ? raw.lastCheckedAt : undefined,
    incarnation: typeof raw.incarnation === 'string' ? raw.incarnation : undefined,
    lastFilename: typeof raw.lastFilename === 'string' ? raw.lastFilename : undefined,
    lastBytes: isFiniteNumber(raw.lastBytes) ? raw.lastBytes : undefined,
    unmanagedCopies: isFiniteNumber(raw.unmanagedCopies) ? raw.unmanagedCopies : undefined,
    lastOutcome:
      typeof raw.lastOutcome === 'string' && VERDICTS.has(raw.lastOutcome)
        ? raw.lastOutcome
        : undefined,
    lastOutcomeAt: isFiniteNumber(raw.lastOutcomeAt) ? raw.lastOutcomeAt : undefined,
    permissionLost: typeof raw.permissionLost === 'boolean' ? raw.permissionLost : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    lastErrorAt: isFiniteNumber(raw.lastErrorAt) ? raw.lastErrorAt : undefined,
  })
}

/** Keeps an explicit `undefined` in a patch meaning "clear this" without
 *  leaving the key behind for `toEqual` — and out of IndexedDB. */
const dropUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

/** Eight lowercase hex, which is what {@link INSTALL_ID_PATTERN} accepts —
 *  `randomUUID` is already that alphabet. */
const mintInstallId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

const SETTINGS_KEY = 'settings'
const DIRECTORY_KEY = 'directory'

/** Record ids for this account on this deployment. Stable across a storage
 *  version bump, distinct between a PR preview and production. */
const keysFor = (userId: string) => {
  const previewId = previewDbId(import.meta.env.BASE_URL)
  const namespace = previewId ? `~${previewId}~${userId}` : userId
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
  /** `ifDirectoryEpoch` makes the write conditional on the folder not having
   *  changed since the caller read it. Checked INSIDE the transaction, because
   *  the whole point is that time passes between the two. */
  recordStatus: (
    userId: string,
    patch: DbMirrorStatus,
    opts?: {ifDirectoryEpoch?: number},
  ) => Promise<DbMirrorState>
  /** The last loaded state, or null before the first load. Stable BETWEEN
   *  writes, which is what `useSyncExternalStore` needs; a re-read publishes a
   *  freshly built object even when storage has not changed, and at one read
   *  per tick that is not worth de-duplicating. */
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
        const record = await promisifyRequest(store.get(keys.settings))
        const directory = (await promisifyRequest(store.get(keys.directory))) as
          | FileSystemDirectoryHandle
          | undefined
        const stored = record as
          | {settings?: unknown; status?: unknown; installId?: unknown; directoryEpoch?: unknown}
          | undefined
        // Validated, not merely typed: the id goes into the copy's NAME, and
        // one that cannot appear there produces files the parser never matches
        // — so nothing prunes them and the skip never finds the last one. A
        // stored id that fails is replaced rather than trusted.
        const known =
          typeof stored?.installId === 'string' && INSTALL_ID_PATTERN.test(stored.installId)
            ? stored.installId
            : undefined
        const updated = mutate({
          settings: normalizeSettings(stored?.settings),
          status: normalizeStatus(stored?.status),
          directory: directory ?? undefined,
          // Minted on the first write, never afterwards. A read must not mint
          // one: the loop reads on every tick, and the id has to be the same
          // one the copies already in the folder were named for.
          installId: known ?? (persist ? mintInstallId() : undefined),
          directoryEpoch: isFiniteNumber(stored?.directoryEpoch) ? stored.directoryEpoch : undefined,
        })
        if (persist) {
          store.put(
            {
              settings: updated.settings,
              status: updated.status,
              installId: updated.installId,
              directoryEpoch: updated.directoryEpoch,
            },
            keys.settings,
          )
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
        // NOT swallowed into the defaults. Answering "off, no folder" for a
        // storage hiccup is the worst possible lie for this feature: the
        // schedule would read an opted-in mirror as disabled and quietly stop
        // copying, a failed save would look like it committed, and the
        // published defaults would replace a perfectly good snapshot on screen.
        // Callers surface it — the loop retries on its short failure delay, the
        // settings dialog says the save did not stick.
        console.warn('[db-mirror] could not read or save settings', err)
        throw err
      })
  }

  const reload = (): void => {
    if (snapshotUserId === null) return
    // A broadcast is a nudge, not a request: a failed re-read leaves the
    // snapshot as it stands and the next one tries again.
    update(snapshotUserId, state => state, false).catch(() => {})
  }
  // The id check is de-duplication, not correctness: `reload` re-reads for
  // whoever the snapshot currently describes either way.
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
    recordStatus: (userId, patch, opts) =>
      update(userId, state =>
        opts?.ifDirectoryEpoch !== undefined && state.directoryEpoch !== opts.ifDirectoryEpoch
          ? state
          : {...state, status: normalizeStatus({...state.status, ...patch})},
      ),
    setDirectory: (userId, directory) =>
      update(userId, state => ({
        ...state,
        directory,
        directoryEpoch: (state.directoryEpoch ?? 0) + 1,
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
