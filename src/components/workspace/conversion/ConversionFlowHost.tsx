import { useCallback } from 'react'
import { useRepo } from '@/context/repo'
import type { ConversionUi } from '@/sync/conversion/runConversion'
import { ConversionFlow } from './ConversionFlow'
import { conversionFlowDeps } from './conversionFlowDeps'
import { closeConversionFlow, useConversionFlowTarget, type ConversionFlowTarget } from './conversionFlowStore'

/** Shows the open conversion flow over whatever the app renders below it,
 *  the workspace or its gate. */
export function ConversionFlowHost() {
  const target = useConversionFlowTarget()
  if (!target) return null
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      {/* One run per workspace: switching the target starts a fresh flow. */}
      <HostedFlow key={target.workspaceId} target={target}/>
    </div>
  )
}

function HostedFlow({target}: {target: ConversionFlowTarget}) {
  const repo = useRepo()
  const makeDeps = useCallback(
    (ui: ConversionUi, signal: AbortSignal) => conversionFlowDeps(repo, target.workspaceId, ui, signal),
    [repo, target.workspaceId],
  )
  return <ConversionFlow workspaceName={target.workspaceName} makeDeps={makeDeps} onClose={closeConversionFlow}/>
}
