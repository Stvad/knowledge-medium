// When you just need a one-shot prompt (no persistent mount, no
// reactive subscription), `openDialog(Component, props)` returns
// a promise that resolves with the user's choice. The dialog
// component receives `resolve(value)` and `cancel()` as props.
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { openDialog, type DialogContextProps } from '@/utils/dialogs.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { showError, showSuccess } from '@/utils/toast.js'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { useState } from 'react'

const ReadwiseTokenPrompt = ({ resolve, cancel }: DialogContextProps<string>) => {
  const [token, setToken] = useState('')
  return (
    <Dialog open={true} onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Paste your Readwise token</DialogTitle></DialogHeader>
        <Input value={token} onChange={e => setToken(e.target.value)} />
        <DialogFooter>
          <Button onClick={() => resolve(token)} disabled={!token}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A bare `actionsFacet.of(...)` at module scope contributes NOTHING — the
// runtime only reads what the module's default export hands back.
export default [
  // `openDialog` is inert without DialogHost mounted: the promise below would
  // never resolve. Pull the mount in here rather than hoping another enabled
  // plugin happens to provide it — the resolver dedupes by contribution
  // reference, so every dialog-using plugin importing this registers exactly
  // one mount.
  dialogAppMountExtension,
  actionsFacet.of({
    id: 'user.readwise.configure',
    description: 'Configure Readwise',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      const token = await openDialog(ReadwiseTokenPrompt)
      if (!token) return  // user cancelled
      const ok = await fetch('https://readwise.io/api/v2/auth/', {
        headers: { Authorization: `Token ${token}` },
      }).then(r => r.status === 204).catch(() => false)
      if (!ok) { showError('Readwise rejected that token.'); return }
      window.localStorage.setItem('knowledge-medium:readwise:token:v1', token)
      showSuccess('Readwise connected.')
    },
  }, { source: 'readwise' }),
]
