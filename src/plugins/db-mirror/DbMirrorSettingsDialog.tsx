/**
 * Settings surface for the database mirror: turn it on/off, pick the folder,
 * tune keep-count and cadence, see the last run's status, and mirror on
 * demand. Opened via `openDialog(DbMirrorSettingsDialog)` from a
 * command-palette action.
 *
 * Reads live state straight from `dbMirrorStore` — no local copy of the
 * settings — so a change from another tab (or from the scheduled run
 * finishing) shows up here without any wiring of its own. Every mutation goes
 * through the store's own methods, which publish the next snapshot
 * themselves.
 *
 * Two actions need the click's own user gesture with NO `await` ahead of
 * them, because `showDirectoryPicker`/`requestPermission` are denied outside
 * one: choosing a folder (`handleToggle`'s no-folder branch, and
 * `handleChooseFolder`) and re-requesting a lapsed permission
 * (`handleGrantAgain`). Each stays a plain (non-async) function that calls
 * the gesture-gated API directly, chaining the rest with `.then`.
 */
import {useEffect, useState, useSyncExternalStore} from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import {Button} from '@/components/ui/button.js'
import {Checkbox} from '@/components/ui/checkbox.js'
import {Input} from '@/components/ui/input.js'
import {Label} from '@/components/ui/label.js'
import {useRepo} from '@/context/repo.js'
import {showError, showInfo, showSuccess} from '@/utils/toast.js'
import type {DialogContextProps} from '@/utils/dialogs.js'
import {
  dbMirrorStore,
  MAX_INTERVAL_MINUTES,
  MAX_KEEP_COUNT,
  MIN_INTERVAL_MINUTES,
  MIN_KEEP_COUNT,
} from './store.js'
import {dbMirrorSchedule, describeError} from './schedule.js'
import {chooseMirrorDirectory, requestDirectoryPermission} from './fileSystemAccess.js'

const INTERVAL_OPTIONS = (
  [
    {minutes: 30, label: '30 minutes'},
    {minutes: 60, label: '1 hour'},
    {minutes: 6 * 60, label: '6 hours'},
    {minutes: 24 * 60, label: '24 hours'},
    {minutes: 7 * 24 * 60, label: '7 days'},
  ] as const
).filter(o => o.minutes >= MIN_INTERVAL_MINUTES && o.minutes <= MAX_INTERVAL_MINUTES)

const MIB = 1024 * 1024
const formatMiB = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`

const formatTime = (at: number): string => new Date(at).toLocaleString()

/** A dismissed `showDirectoryPicker()` — not a failure worth reporting. */
const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

export function DbMirrorSettingsDialog({cancel}: DialogContextProps<void>) {
  const repo = useRepo()
  const userId = repo.user.id
  const state = useSyncExternalStore(dbMirrorStore.subscribe, dbMirrorStore.getSnapshot, dbMirrorStore.getSnapshot)
  const [running, setRunning] = useState(false)
  const [granting, setGranting] = useState(false)
  /** What the keep-count field shows while it is being edited, or null when it
   *  shows the stored value. The input is controlled, so without somewhere to
   *  hold a half-typed value React restores the old number the moment the field
   *  is cleared — backspace-then-type fights the user. */
  const [keepDraft, setKeepDraft] = useState<string | null>(null)

  useEffect(() => {
    dbMirrorStore
      .load(userId)
      .catch(err => showError(`Could not read the mirror settings: ${describeError(err)}`))
  }, [userId])

  const reportChooseFailure = (err: unknown): void => {
    if (isAbort(err)) return
    showError(`Could not choose a folder: ${describeError(err)}`)
  }

  /** Storage can refuse a write (a private window, site data off). The store
   *  rejects rather than pretending it saved, so every write says so. */
  const saving = <T,>(write: Promise<T>): Promise<T | undefined> =>
    write.catch(err => {
      showError(`Could not save the mirror settings: ${describeError(err)}`)
      return undefined
    })

  // Not async: the no-folder branch calls `chooseMirrorDirectory()` with
  // nothing awaited ahead of it, so the picker still sees the checkbox
  // click's own user gesture.
  const handleToggle = (checked: boolean): void => {
    if (!checked) {
      void saving(dbMirrorStore.updateSettings(userId, {enabled: false}))
      return
    }
    if (state?.directory) {
      void saving(dbMirrorStore.updateSettings(userId, {enabled: true}))
        .then(saved => { if (saved) dbMirrorSchedule.resume() })
      return
    }
    chooseFolder({andEnable: true})
  }

  /** Pick a folder, save it, and bring the next run forward — the store clears
   *  the previous folder's recorded failure, and without the re-arm the new
   *  folder would wait out a delay chosen before it was chosen.
   *
   *  NOT async, for the same reason as `handleToggle`: `chooseMirrorDirectory`
   *  is called with nothing awaited ahead of it, so it still runs inside the
   *  click's own user gesture. */
  const chooseFolder = ({andEnable}: {andEnable: boolean}): void => {
    chooseMirrorDirectory()
      .catch(err => { reportChooseFailure(err); return undefined })
      .then(async directory => {
        if (!directory) return
        // Past the picker: store failures are reported as saves, not as a
        // folder that could not be chosen.
        if (!(await saving(dbMirrorStore.setDirectory(userId, directory)))) return
        if (andEnable && !(await saving(dbMirrorStore.updateSettings(userId, {enabled: true})))) return
        dbMirrorSchedule.resume()
      })
  }

  const handleChooseFolder = (): void => chooseFolder({andEnable: false})

  const handleForgetFolder = (): void => {
    void saving(dbMirrorStore.setDirectory(userId, undefined))
  }

  /** Typed, not saved. Saving per keystroke made every intermediate value a
   *  real setting: going from 3 to 12 commits "1" on the way, and a run in this
   *  or any other tab that reads the record in that instant prunes the folder
   *  down to a single copy. The draft is what the field shows; the store only
   *  hears about it when the user is finished. */
  const handleKeepCountChange = (value: string): void => setKeepDraft(value)

  const commitKeepCount = (): void => {
    const draft = keepDraft
    setKeepDraft(null)
    if (draft === null) return
    // An emptied or half-typed field is not a request for the minimum, so it
    // reverts to the stored value rather than saving something the user did not
    // mean. The store clamps what IS a number.
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) return
    void saving(dbMirrorStore.updateSettings(userId, {keepCount: parsed}))
  }

  const handleIntervalChange = (value: string): void => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    // Re-arm, don't just save: the loop is sitting on a delay chosen before this
    // change existed, so going from 24 hours to 30 minutes would otherwise still
    // leave the next copy a day away.
    void saving(dbMirrorStore.updateSettings(userId, {intervalMinutes: parsed}))
      .then(saved => { if (saved) dbMirrorSchedule.resume(parsed * 60_000) })
  }

  // Not async: `requestDirectoryPermission` is called directly, with nothing
  // awaited ahead of it, so it still runs inside the button click's gesture.
  const handleGrantAgain = (): void => {
    const directory = state?.directory
    if (!directory) return
    setGranting(true)
    requestDirectoryPermission(directory)
      .then(async result => {
        if (result === 'granted') {
          const cleared = await saving(dbMirrorStore.recordStatus(userId, {
            permissionLost: false,
            lastError: undefined,
            lastErrorAt: undefined,
          }))
          if (cleared) dbMirrorSchedule.resume()
        } else {
          showError('The browser refused to grant access to the folder again.')
        }
      })
      .catch(err => showError(`Could not request permission: ${describeError(err)}`))
      .finally(() => setGranting(false))
  }

  const handleMirrorNow = async (): Promise<void> => {
    setRunning(true)
    try {
      const {outcome} = await dbMirrorSchedule.runNow(repo)
      switch (outcome.kind) {
        case 'mirrored':
          showSuccess(`Wrote ${outcome.filename} (${formatMiB(outcome.bytes)})`)
          break
        case 'skipped-unchanged':
          // Neither a success nor a failure: nothing was wrong, nothing was written.
          showInfo('Nothing has changed since the last copy, so none was written.')
          break
        case 'permission-lost':
          // Short, because the full sentence is already on screen: the same run
          // stored it as `lastError`, which renders a few lines below next to
          // the button that fixes it.
          showError('The folder is no longer writable — see below.')
          break
        case 'disabled':
          showError('Mirroring is turned off.')
          break
        case 'no-folder':
          showError('No folder has been chosen yet.')
          break
        case 'busy-elsewhere':
          showInfo('Another tab of this app is already making a copy — this one left it to that tab.')
          break
        case 'no-identity':
          showError(
            'This device could not tell which database it is holding, so no copy was written. ' +
            'If the app has just rebuilt its local database, try again once it has finished syncing.',
          )
          break
        case 'too-soon':
          // Not reachable today — "Mirror now" runs forced, and the retry after
          // a join is forced too — but the exhaustive switch wants every kind
          // answered, and this is the honest answer if it ever is.
          showInfo('A copy was taken moments ago on this device, so none was written.')
          break
        default: {
          // Exhaustiveness: a new outcome kind is a compile error here rather
          // than a button press that silently reports nothing, which is how
          // `busy-elsewhere` went unhandled when it was added.
          const unhandled: never = outcome
          showError(`The mirror reported something unexpected: ${JSON.stringify(unhandled)}`)
        }
      }
    } catch (err) {
      showError(describeError(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) cancel()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mirror this device&rsquo;s database</DialogTitle>
          <DialogDescription>
            This app keeps its database in browser storage, which the browser can clear without
            warning. Mirroring keeps a copy of this device&rsquo;s database in a folder on disk that
            survives that. The folder has to stay reachable from this device, and each device
            mirrors on its own.
          </DialogDescription>
        </DialogHeader>

        {!state ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="db-mirror-enabled"
                checked={state.settings.enabled}
                onCheckedChange={next => handleToggle(next === true)}
              />
              <Label htmlFor="db-mirror-enabled">Mirror this device&rsquo;s database to a folder</Label>
            </div>

            <div className="space-y-1">
              <div className="text-sm">
                Folder: {state.directory ? state.directory.name : 'No folder chosen'}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleChooseFolder}>
                  {state.directory ? 'Change folder…' : 'Choose folder…'}
                </Button>
                {state.directory && (
                  <Button type="button" variant="outline" size="sm" onClick={handleForgetFolder}>
                    Forget folder
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="db-mirror-keep-count">Keep</Label>
              <Input
                id="db-mirror-keep-count"
                type="number"
                min={MIN_KEEP_COUNT}
                max={MAX_KEEP_COUNT}
                step={1}
                inputMode="numeric"
                value={keepDraft ?? String(state.settings.keepCount)}
                onChange={event => handleKeepCountChange(event.target.value)}
                onBlur={commitKeepCount}
                onKeyDown={event => { if (event.key === 'Enter') commitKeepCount() }}
              />
              <p className="text-xs text-muted-foreground">
                Copies kept in the folder. Only ones this device wrote for the database it holds
                now are ever deleted.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="db-mirror-interval">How often</Label>
              <select
                id="db-mirror-interval"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={state.settings.intervalMinutes}
                onChange={event => handleIntervalChange(event.target.value)}
              >
                {INTERVAL_OPTIONS.map(option => (
                  <option key={option.minutes} value={option.minutes}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                At most this often, when the app is idle — the schedule waits for a genuinely idle
                moment, so this is a floor, not a promise.
              </p>
            </div>

            <div className="space-y-1 text-sm">
              {state.status.lastMirrorAt !== undefined ? (
                <div>
                  Last mirror: {formatTime(state.status.lastMirrorAt)} — {state.status.lastFilename} (
                  {formatMiB(state.status.lastBytes ?? 0)})
                </div>
              ) : (
                <div className="text-muted-foreground">No copy yet</div>
              )}
              {state.status.lastCheckedAt !== undefined &&
                state.status.lastCheckedAt !== state.status.lastMirrorAt && (
                  <div className="text-xs text-muted-foreground">
                    Last checked: {formatTime(state.status.lastCheckedAt)}
                  </div>
                )}
              {state.status.unmanagedCopies !== undefined && state.status.unmanagedCopies > 0 && (
                <div className="text-xs text-muted-foreground">
                  Plus {state.status.unmanagedCopies}{' '}
                  {state.status.unmanagedCopies === 1 ? 'copy' : 'copies'} this device does not
                  manage — from another device, from a database this one replaced, that it could not
                  open, or taken while it could not identify the database. They are kept whatever the
                  number above says; delete them yourself when you no longer want them.
                </div>
              )}
              {state.status.lastError && (
                <div className="font-medium text-destructive">{state.status.lastError}</div>
              )}
              {state.status.permissionLost && (
                <Button type="button" size="sm" onClick={handleGrantAgain} disabled={granting}>
                  {granting ? 'Requesting…' : 'Grant access again'}
                </Button>
              )}
            </div>

            <Button type="button" onClick={() => void handleMirrorNow()} disabled={running}>
              {running ? 'Mirroring…' : 'Mirror now'}
            </Button>

            <p className="text-xs text-muted-foreground">
              This setting and the folder you pick live in the same browser storage as the
              database. A browser that clears all of it takes them too — mirroring comes back off,
              and the copies already in the folder are left untouched but unmanaged. Turn it back
              on and pick the folder again.
            </p>

            <p className="text-xs text-muted-foreground">
              <span className="font-medium">To use a copy:</span> run the{' '}
              <span className="font-medium">
                Replace database with an uploaded SQLite file or recovery archive
              </span>{' '}
              command and pick the file. After a browser clears its storage the folder can hold
              copies of more than one database, and the newest file is not always the one you want:
              each name carries the database it came from, so prefer the newest copy sharing a name
              with the last one listed above — that is the one holding your work, not the empty
              database the app rebuilt.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
