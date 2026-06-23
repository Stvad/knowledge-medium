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
import { flushUploadQueue } from '@/sync/flushUploadQueue.js'
import { getPowerSyncDb } from '@/data/repoProvider.js'
import { supabase } from '@/services/supabase.js'

export interface WipeLocalDataDialogProps {
  /** The signed-in user whose PowerSync upload queue we drain before wiping. */
  userId: string
}

type FlushState =
  | { status: 'flushing' }
  | { status: 'flushed' }
  | { status: 'unflushed'; remaining: number }
  | { status: 'error'; message: string }

// Per-browser steps for the "clear site data" control. We can't open this UI
// from a page (no JS API) and can't emit a Clear-Site-Data header on GitHub
// Pages — a service worker can't synthesize one either (verified:
// docs/clear-site-data-spike/) — so the browser's own control is the real wipe.
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
 * "Wipe local data" panic surface. The app can't reliably destroy origin
 * storage from JS, so this dialog does the parts it CAN — drain unsynced
 * uploads (best-effort) and sign the user out — then guides them to the
 * browser/OS "clear site data" control, which removes the local DB from
 * outside the page context. Stays on screen (unlike a one-shot alert) while
 * the user works the browser menus.
 */
export const WipeLocalDataDialog = ({
  userId,
  cancel,
}: WipeLocalDataDialogProps & DialogContextProps<void>) => {
  const [flush, setFlush] = useState<FlushState>({ status: 'flushing' })
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { flushed, remaining } = await flushUploadQueue(getPowerSyncDb(userId))
        if (cancelled) return
        setFlush(flushed ? { status: 'flushed' } : { status: 'unflushed', remaining })
      } catch (err) {
        if (cancelled) return
        setFlush({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const handleSignOutAndReload = async (): Promise<void> => {
    setSigningOut(true)
    try {
      // scope:'local' clears THIS device's session (and broadcasts SIGNED_OUT to
      // sibling tabs) without a server round-trip — works offline. The reload
      // then drops in-memory plaintext and releases the OPFS DB handle, so this
      // tab isn't left authenticated/showing data after the user clears storage.
      await supabase?.auth.signOut({ scope: 'local' })
    } catch {
      // best-effort: reload anyway.
    }
    window.location.reload()
  }

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
            This signs you out and helps you remove all data this app stored on this
            device. Anything already synced re-downloads when you sign back in; anything
            not synced (or that only exists on this device) is permanently lost.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {flush.status === 'flushing' && (
            <p className="text-muted-foreground">Saving unsynced changes…</p>
          )}
          {flush.status === 'flushed' && (
            <p className="text-muted-foreground">Unsynced changes saved.</p>
          )}
          {flush.status === 'unflushed' && (
            <p className="text-destructive">
              {flush.remaining} change(s) haven’t been copied off this device yet (you may
              be offline, or syncing is off) — they’ll be lost when you clear the data.
            </p>
          )}
          {flush.status === 'error' && (
            <p className="text-destructive">Couldn’t check for unsynced changes: {flush.message}</p>
          )}

          <div className="space-y-2">
            <p>
              The wipe itself is done by your browser’s <strong>“clear site data”</strong>{' '}
              control — that’s what removes the local database, which lives in storage this
              page can’t fully delete on its own:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {CLEAR_DATA_STEPS.map(({ browser, steps }) => (
                <li key={browser}>
                  <span className="font-medium">{browser}:</span> {steps}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              If you have other tabs of this app open, close or reload them too — until you
              do, they keep showing your data.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => cancel()} disabled={signingOut}>
            Cancel
          </Button>
          <Button onClick={handleSignOutAndReload} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out & reload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
