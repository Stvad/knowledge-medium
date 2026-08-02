/** A one-shot confirmation, on the app's dialog channel.
 *
 *  Not `window.confirm`: the repo routes dialogs, pickers and one-shot prompts
 *  through `openDialog` so they mount in DialogHost and resolve as typed
 *  promises. A browser global sidesteps that entirely — it cannot be styled,
 *  cannot be tested through the same seam, and blocks the whole tab.
 */

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
  <div className="flex max-w-sm flex-col gap-3 p-4">
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
        onClick={() => cancel()}
      >Keep it</button>
      <button
        type="button"
        className={destructive
          ? 'rounded bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90'
          : 'rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90'}
        onClick={() => resolve(true)}
      >{confirmLabel}</button>
    </div>
  </div>
)
ConfirmDialog.displayName = 'ConfirmDialog'
