import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DialogContextProps } from '@/utils/dialogs.js'

export interface BridgePairingDialogProps {
  /** Loopback bridge URL the link wants to pair with. The caller has
   *  already validated this is a loopback address before opening the
   *  dialog — we never prompt for a non-loopback endpoint. */
  url: string
  /** Whether the link also carried a pairing secret. */
  hasSecret: boolean
}

/**
 * Confirmation gate for link-initiated bridge pairing. A crafted link
 * can put an `agent-runtime-url` / `agent-runtime-secret` in the page
 * hash; honoring it silently would let any page redirect the bridge and
 * exfiltrate the user's agent tokens (and run arbitrary commands as
 * them). So persistence of a hash-supplied pairing is gated behind this
 * explicit, user-driven confirmation — `resolve(true)` means "pair",
 * cancel means "don't".
 */
export function BridgePairingDialog({
  url,
  hasSecret,
  resolve,
  cancel,
}: DialogContextProps<boolean> & BridgePairingDialogProps) {
  return (
    <Dialog open onOpenChange={next => { if (!next) cancel() }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect to local agent bridge?</DialogTitle>
          <DialogDescription>
            A link is asking to connect this workspace to a local agent
            runtime bridge. Once connected, a process on this machine can
            read and modify this workspace as you — including running
            code. Only continue if you just started this from your own
            terminal (e.g. <code>pnpm agent connect</code>).
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 rounded-md border bg-muted/40 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Bridge URL</p>
          <code className="block min-w-0 break-all text-xs font-mono">{url}</code>
          {hasSecret && (
            <p className="text-xs text-muted-foreground">
              The link also supplied a pairing secret for this bridge.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => cancel()}>
            Cancel
          </Button>
          <Button type="button" onClick={() => resolve(true)}>
            Pair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
