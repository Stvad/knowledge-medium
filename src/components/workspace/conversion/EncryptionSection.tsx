import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion'
import { stageOf } from '@/sync/conversion/stage'
import { getModePin } from '@/sync/keys/modePin'
import type { Workspace } from '@/types'
import { openConversionFlow } from './conversionFlowStore'

/** What the server shows of a conversion on this e2ee workspace: a stage still
 *  running, none, or a read that failed and so may be hiding one. */
type ConversionCheck = 'sealing' | 'cleaning' | 'unavailable' | null

const useConversionCheck = (workspaceId: string, userId: string, check: boolean) => {
  const [result, setResult] = useState<ConversionCheck>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!check) return
    let live = true
    void fetchWorkspaceConversionState(workspaceId).then(read => {
      if (!live) return
      const stage = stageOf(read, userId)
      const kind = stage.kind === 'stage' ? stage.stage.kind : stage.kind
      setResult(kind === 'sealing' || kind === 'cleaning' || kind === 'unavailable' ? kind : null)
    })
    return () => { live = false }
  }, [workspaceId, userId, check, attempt])
  return {result: check ? result : null, retry: () => setAttempt(n => n + 1)}
}

export function EncryptionSection({workspace, userId, onStart}: {workspace: Workspace, userId: string, onStart: () => void}) {
  const {result, retry} = useConversionCheck(workspace.id, userId, workspace.encryptionMode === 'e2ee')
  // Only from a device that has verified the workspace is plaintext: an unpinned
  // one (the quarantine gate) can't trust the server's 'none'.
  const canStart = workspace.encryptionMode === 'none' && getModePin(userId, workspace.id) === 'plaintext'
  if (!canStart && !result) return null
  if (result === 'unavailable') {
    return (
      <div className="space-y-2 rounded-md border p-3">
        <Label>End-to-end encryption</Label>
        <p className="text-sm text-muted-foreground">
          Couldn't check with the server whether this workspace's conversion is finished.
        </p>
        <Button variant="outline" onClick={retry}>Check again</Button>
      </div>
    )
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>End-to-end encryption</Label>
      <p className="text-sm text-muted-foreground">
        {result === 'cleaning'
          ? "This workspace's content is encrypted, but its attachments still need converting."
          : result === 'sealing'
          ? "This workspace's conversion to end-to-end encryption is under way."
          : "Encrypt this workspace's content with a key only you hold. Links, ids and history on this device are kept. It can't be undone."}
      </p>
      <Button
        variant="outline"
        onClick={() => {
          onStart()
          openConversionFlow({userId, workspaceId: workspace.id, workspaceName: workspace.name})
        }}
      >
        {result === 'cleaning' ? 'Finish the conversion…' : result === 'sealing' ? 'Continue the conversion…' : 'Encrypt this workspace…'}
      </Button>
    </div>
  )
}
