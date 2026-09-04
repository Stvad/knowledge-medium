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
import {dbMirrorSchedule, PERMISSION_LOST_MESSAGE} from './schedule.js'
import {chooseMirrorDirectory, requestDirectoryPermission} from './fileSystemAccess.js'

const INTERVAL_OPTIONS = (
  [
    {minutes: 30, label: '30 minutes'},
    {minutes: 60, label: '1 hour'},
    {minutes: 6 * 60, label: '6 hours'},
    {minutes: 24 * 60, label: '24 hours'},
  ] as const
).filter(o => o.minutes >= MIN_INTERVAL_MINUTES && o.minutes <= MAX_INTERVAL_MINUTES)

const MIB = 1024 * 1024
const formatMiB = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`

const formatTime = (at: number): string => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString()
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A dismissed `showDirectoryPicker()` — not a failure worth reporting. */
const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

export function DbMirrorSettingsDialog({cancel}: DialogContextProps<void>) {
  const repo = useRepo()
  const userId = repo.user.id
  const state = useSyncExternalStore(dbMirrorStore.subscribe, dbMirrorStore.getSnapshot, dbMirrorStore.getSnapshot)
  const [running, setRunning] = useState(false)
  const [granting, setGranting] = useState(false)

  useEffect(() => {
    void dbMirrorStore.load(userId)
  }, [userId])

  const reportChooseFailure = (err: unknown): void => {
    if (isAbort(err)) return
    showError(`Could not choose a folder: ${describeError(err)}`)
  }

  // Not async: the no-folder branch calls `chooseMirrorDirectory()` with
  // nothing awaited ahead of it, so the picker still sees the checkbox
  // click's own user gesture.
  const handleToggle = (checked: boolean): void => {
    if (!checked) {
      void dbMirrorStore.updateSettings(userId, {enabled: false})
      return
    }
    if (state?.directory) {
      void dbMirrorStore.updateSettings(userId, {enabled: true}).then(() => dbMirrorSchedule.resume())
      return
    }
    chooseMirrorDirectory()
      .then(async directory => {
        if (!directory) return
        await dbMirrorStore.setDirectory(userId, directory)
        await dbMirrorStore.updateSettings(userId, {enabled: true})
        dbMirrorSchedule.resume()
      })
      .catch(reportChooseFailure)
  }

  // Not async, for the same reason as `handleToggle`.
  const handleChooseFolder = (): void => {
    chooseMirrorDirectory()
      .then(async directory => {
        if (!directory) return
        await dbMirrorStore.setDirectory(userId, directory)
        // The store clears the previous folder's failure; this restarts the
        // loop that failure had stopped.
        dbMirrorSchedule.resume()
      })
      .catch(reportChooseFailure)
  }

  const handleForgetFolder = (): void => {
    void dbMirrorStore.setDirectory(userId, undefined)
  }

  const handleKeepCountChange = (value: string): void => {
    // An emptied field is someone part-way through typing a new number, not a
    // request for the minimum — clamping it would fight them mid-edit.
    if (value.trim() === '') return
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    void dbMirrorStore.updateSettings(userId, {keepCount: parsed})
  }

  const handleIntervalChange = (value: string): void => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    void dbMirrorStore.updateSettings(userId, {intervalMinutes: parsed})
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
          await dbMirrorStore.recordStatus(userId, {
            permissionLost: false,
            lastError: undefined,
            lastErrorAt: undefined,
          })
          dbMirrorSchedule.resume()
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
          showError(PERMISSION_LOST_MESSAGE)
          break
        case 'disabled':
          showError('Mirroring is turned off.')
          break
        case 'no-folder':
          showError('No folder has been chosen yet.')
          break
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
                value={state.settings.keepCount}
                onChange={event => handleKeepCountChange(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Copies kept in the folder; older ones this app wrote are deleted.
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
