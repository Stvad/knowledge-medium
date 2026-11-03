/**
 * The prompts that put the recovery bundle's folder in the run's hands.
 * The picker and the permission request must start inside the click, which is
 * why they run here rather than in the run.
 */

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Explanation } from '@/components/workspace/keyUi'
import type { BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import type { BundleRetakeReason, ReopenBundlePrompt } from '@/sync/conversion/sealingStage'
import { isPickerDismissal, pickDirectory, requestDirectoryPermission } from '@/utils/fileSystemAccess'
import { directoryHandleOf } from './conversionFlowDeps'
import { Actions, errorMessage } from './flowUi'

/** Runs a picker or permission prompt, which must start inside the click:
 *  a dismissal is no error, anything else is shown. One at a time: a second
 *  click while one is open does nothing. */
const usePickerAction = () => {
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const act = (pick: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setError(null)
    pick().catch((err: unknown) => {
      if (!isPickerDismissal(err)) setError(errorMessage(err))
    }).finally(() => {
      pending.current = false
    })
  }
  return {error, act}
}

const RETAKE_REASON: Record<BundleRetakeReason, string | null> = {
  stale: 'The server holds changes the earlier bundle lacks, so it no longer counts. Take a new one; the old folder can go.',
  changed: "The earlier bundle's files no longer match what this device recorded, so it no longer counts. Take a new one.",
  requested: null,
}

export function ChooseBundleFolderPrompt({reason, answer, cancel}: {
  reason: BundleRetakeReason | null
  answer: (folder: BundleFolder) => void
  cancel: () => void
}) {
  const {error, act} = usePickerAction()
  return (
    <>
      {reason && RETAKE_REASON[reason] && <p className="text-sm text-destructive">{RETAKE_REASON[reason]}</p>}
      <Explanation>
        Next, a recovery bundle: a folder holding a plain copy of every block, the server's history
        and this device's database. Together with the key, it's what the workspace can be restored
        from if the key is ever lost. It's as sensitive as the workspace itself, so pick a folder on
        an encrypted disk, and keep it with the key.
      </Explanation>
      <Explanation>The bundle goes in a new folder inside the one you pick.</Explanation>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Actions
        primary={{
          label: 'Choose a folder',
          onClick: () => act(async () => {
            const directory = await pickDirectory({id: 'km-e2ee-recovery', mode: 'readwrite'})
            if (directory) answer(directory)
          }),
        }}
        secondary={{label: 'Cancel', onClick: cancel}}
      />
    </>
  )
}

const REOPEN_PURPOSE: Record<ReopenBundlePrompt['purpose'], {why: string; without: string}> = {
  purge: {
    why: "Before the server's history is deleted, this device reads the recovery bundle once more, to make sure it is still complete.",
    without: 'Take a new bundle',
  },
  cleanup: {
    why: 'The attachment cleanup deletes an object the recovery bundle archived only once it has read the copy in the bundle.',
    without: 'Go on without it',
  },
}

export function ReopenBundleFolderPrompt({prompt: {recorded, problem, purpose, archived}, answer, cancel}: {
  prompt: ReopenBundlePrompt
  answer: (folder: BundleFolder | null) => void
  cancel: () => void
}) {
  const {error, act} = usePickerAction()
  const [denied, setDenied] = useState(false)
  const directory = directoryHandleOf(recorded)
  return (
    <>
      <Explanation>
        {REOPEN_PURPOSE[purpose].why} Allow access to its folder, "{recorded.name}", or pick it (or the
        folder you made it in) if it has moved.
      </Explanation>
      {purpose === 'cleanup' && (
        <Explanation>
          {archived > 0
            ? `Without it, the ${archived} object(s) it archived stay on the server, and the conversion can't finish.`
            : "Without it, an attachment missing everywhere else can't be rebuilt from it."}
        </Explanation>
      )}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      {denied && <p className="text-sm text-destructive">Access wasn't granted. Choose the folder instead.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
        <Button type="button" variant="secondary" onClick={() => answer(null)}>{REOPEN_PURPOSE[purpose].without}</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => act(async () => {
            const picked = await pickDirectory({id: 'km-e2ee-recovery', mode: 'read'})
            if (picked) answer(picked)
          })}
        >
          Choose the folder
        </Button>
        <Button
          type="button"
          onClick={() => act(async () => {
            const granted = (await requestDirectoryPermission(directory, 'read')) === 'granted'
            setDenied(!granted)
            if (granted) answer(recorded)
          })}
        >
          Allow access
        </Button>
      </div>
    </>
  )
}

/** This device has no record of the bundle: another device took it, or this
 *  browser's storage was cleared. */
export function ChooseExistingBundlePrompt({problem, answer, cancel}: {
  problem: string | null
  answer: (folder: BundleFolder) => void
  cancel: () => void
}) {
  const {error, act} = usePickerAction()
  return (
    <>
      <Explanation>
        To clean up the workspace's attachments, this device needs the recovery bundle taken when the
        conversion started, and it has no record of it. Choose the bundle's folder: the one holding
        manifest.json.
      </Explanation>
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Actions
        primary={{
          label: 'Choose the folder',
          onClick: () => act(async () => {
            const directory = await pickDirectory({id: 'km-e2ee-recovery', mode: 'read'})
            if (directory) answer(directory)
          }),
        }}
        secondary={{label: 'Cancel', onClick: cancel}}
      />
    </>
  )
}
