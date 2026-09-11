/** A one-shot confirmation, on the app's dialog channel.
 *
 *  Not `window.confirm`: the repo routes dialogs, pickers and one-shot prompts
 *  through `openDialog` so they mount in DialogHost and resolve as typed
 *  promises. A browser global sidesteps that entirely — it cannot be styled,
 *  cannot be tested through the same seam, and blocks the whole tab.
 */

import {Button} from '@/components/ui/button.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import type {DialogContextProps} from '@/utils/dialogs.js'

export interface ConfirmProps {
  title: string
  body: string
  /** Label for the action that goes ahead. Says what happens, not "OK". */
  confirmLabel: string
  destructive?: boolean
}

export const ConfirmDialog = ({
  title,
  body,
  confirmLabel,
  destructive,
  resolve,
  cancel,
}: DialogContextProps<true> & ConfirmProps) => (
  // The app's modal chrome — see `StartSessionDialog` for why a dialog that
  // brings none of its own lands stacked above the outline instead of over it.
  <Dialog open onOpenChange={next => { if (!next) cancel() }}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => cancel()}>Keep it</Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={() => resolve(true)}
        >{confirmLabel}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)
ConfirmDialog.displayName = 'ConfirmDialog'
