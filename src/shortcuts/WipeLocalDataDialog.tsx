import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { getPowerSyncDb } from '@/data/repoProvider.js'

export interface WipeLocalDataDialogProps {
  /** Signed-in user — used only to read this device's unsynced-change count. */
  userId: string
}

// Server-rejected edits live here (the upload handler records them then completes
// the tx, so they DON'T show in the live upload-queue count) — but they exist
// only on this device, so a wipe destroys them. Created via CREATE TABLE IF NOT
// EXISTS in clientSchema.ts; query mirrors system-status's rejected-count read.
const REJECTED_COUNT_SQL = 'SELECT COUNT(*) AS count FROM ps_crud_rejected'

// Per-browser steps for the "clear site data" control. We can't open this UI
// from a page (no JS API) and can't emit a Clear-Site-Data header on GitHub
// Pages — a service worker can't synthesize one either (verified:
// docs/clear-site-data-spike/) — so the browser's own control is the wipe.
const CLEAR_DATA_STEPS: readonly { browser: string; steps: string }[] = [
  {
    browser: 'Chrome / Edge',
    steps:
      'click the icon at the left of the address bar → Cookies and site data → ' +
      'Delete (or Settings → Privacy and security → Site settings → this site → Delete data).',
  },
  {
    browser: 'Firefox',
    steps:
      'Settings → Privacy & Security → Cookies and Site Data → Manage Data → ' +
      'select this site → Remove Selected → Save Changes.',
  },
  {
    browser: 'Safari (Mac)',
    steps: 'Settings → Privacy → Manage Website Data → select this site → Remove.',
  },
  {
    browser: 'Safari (iOS)',
    steps: 'Settings app → Safari → Advanced → Website Data → select this site → swipe to delete.',
  },
  {
    browser: 'Installed app (Android / desktop PWA)',
    steps: 'OS app settings → Storage → Clear data, or remove and reinstall the app.',
  },
]

/**
 * "Wipe local data" — pure guidance. The app can't reliably destroy origin
 * storage from JS, so this dialog just explains how to use the browser/OS
 * "clear site data" control, which erases everything (local DB, keys, auth
 * session) from outside the page. Sync runs in the background, so we don't
 * drain anything here — we only WARN if there are still-unsynced changes
 * (e.g. you're offline), which a wipe would lose.
 */
export const WipeLocalDataDialog = ({
  userId,
  cancel,
}: WipeLocalDataDialogProps & DialogContextProps<void>) => {
  // null while we read the count; a number once known. Local SQLite reads, no
  // network — safe even offline. Counts both the live upload queue AND
  // server-rejected rows: both are local-only changes a wipe would destroy.
  const [unsynced, setUnsynced] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const db = getPowerSyncDb(userId)
        const { count: queued } = await db.getUploadQueueStats()
        let rejected = 0
        try {
          const row = await db.get<{ count: number }>(REJECTED_COUNT_SQL)
          rejected = Number(row?.count ?? 0)
        } catch {
          // table absent / unreadable — ignore, just don't count rejected.
        }
        if (!cancelled) setUnsynced(queued + rejected)
      } catch {
        // best-effort: if we can't read at all, just skip the warning.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) cancel()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Wipe local data on this device</DialogTitle>
          <DialogDescription>
            This erases everything this app stored on this device and signs you out.
            Anything already synced re-downloads when you sign back in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {unsynced != null && unsynced > 0 && (
            <p className="text-destructive">
              You have {unsynced} local change(s) that aren’t synced to the server.
              Clearing the data permanently deletes anything not synced — there’s no undo.
              If you’re online with sync enabled, let it finish syncing first (changes made
              in local-only mode, or rejected by the server, can’t sync and will be lost).
            </p>
          )}

          <div className="space-y-2">
            <p>
              The wipe is done by your browser’s <strong>“clear site data”</strong> control:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {CLEAR_DATA_STEPS.map(({ browser, steps }) => (
                <li key={browser}>
                  <span className="font-medium">{browser}:</span> {steps}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              After clearing, close or reload every tab of this app (including this one) —
              until you do, an open tab stays signed in and keeps showing your data.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => cancel()}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
