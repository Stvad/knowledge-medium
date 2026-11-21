import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { useRepo } from '@/context/repo.js'
import { showError, showSuccess } from '@/utils/toast.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { createToggleStore } from '@/utils/toggleStore.js'
import { useState, useSyncExternalStore } from 'react'

const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'

// Visibility is a typed module store — NOT a window CustomEvent, and not a
// hand-rolled boolean + listener Set. `createToggleStore` is the blessed
// toggle seam: the configure action flips it directly, the mounted component
// reads it with useSyncExternalStore, the same mechanism the app's own
// DialogHost uses. (For a one-shot prompt that just returns a value, prefer
// the imperative `openDialog(Component)` shape below instead.)
const settingsDialog = createToggleStore('readwise.settings')

const ReadwiseSetupDialog = () => {
  const repo = useRepo()  // access Repo from inside an appMountsFacet component
  const open = useSyncExternalStore(settingsDialog.subscribe, settingsDialog.isOpen)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const ok = await fetch('https://readwise.io/api/v2/auth/', {
        headers: { Authorization: `Token ${token}` },
      }).then(r => r.status === 204).catch(() => false)
      if (!ok) {
        showError('Readwise rejected that token. Check it and try again.')
        return
      }
      window.localStorage.setItem(TOKEN_KEY, token)
      // repo is available here if you need to write workspace state too.
      void repo  // (silence unused — show the access pattern)
      showSuccess('Readwise connected.')
      settingsDialog.close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={settingsDialog.set}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Readwise</DialogTitle>
          <DialogDescription>
            Get a token from readwise.io/access_token and paste it here.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor='rw-token'>Access token</Label>
        <Input
          id='rw-token'
          value={token}
          onChange={e => setToken(e.target.value)}
          disabled={saving}
        />
        <DialogFooter>
          <Button onClick={save} disabled={!token || saving}>
            {saving ? 'Validating…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default [
  appMountsFacet.of(
    { id: 'readwise.setup-dialog', component: ReadwiseSetupDialog },
    { source: 'readwise' },
  ),
  actionsFacet.of({
    id: 'user.readwise.configure',
    description: 'Configure Readwise',
    context: ActionContextTypes.GLOBAL,
    handler: () => settingsDialog.open(),
  }, { source: 'readwise' }),
]
