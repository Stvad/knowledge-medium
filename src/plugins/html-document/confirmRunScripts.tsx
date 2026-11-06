import {useEffect, useState} from 'react'
import {Button} from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'

/** Past the next click of a double click, or of a click aimed at where this opens. */
const ARM_DELAY_MS = 500

const ConfirmRunScriptsDialog = ({resolve, cancel}: DialogContextProps<true>) => {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <Dialog open onOpenChange={next => { if (!next) cancel() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Run this document's scripts?</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          They can't read your notes, but until you stop them they can capture what you type and reach the network.
          This applies to this version of the document, on this device.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>Cancel</Button>
          <Button disabled={!armed} onClick={() => resolve(true)}>Run scripts</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The strip's button alone isn't consent. A document above this one can resize
 *  or scroll the page with no script running, so it can slide that button under a
 *  click meant for something it drew. Page layout can't move a dialog. */
export const confirmRunScripts = async (): Promise<boolean> =>
  await openDialog(ConfirmRunScriptsDialog, {}) === true
