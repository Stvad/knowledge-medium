import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback, useEffect, useMemo } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Button } from '@/components/ui/button'
import { useIsLocalOnly } from '@/components/Login'
import { Explanation, GateCard } from '@/components/workspace/keyUi'
import { useRepo } from '@/context/repo'
import { cancelArmedHolds } from '@/shortcuts/holdRegistry'
import type { ConversionUi } from '@/sync/conversion/runConversion'
import { ConversionFlow } from './ConversionFlow'
import { conversionFlowDeps, conversionUnavailable } from './conversionFlowDeps'
import { closeConversionFlow, useConversionFlowTarget, type ConversionFlowTarget } from './conversionFlowStore'

const preventDefault = (event: Event) => event.preventDefault()
const keepFromShortcuts = (event: {stopPropagation(): void}) => event.stopPropagation()

/**
 * Shows the open conversion flow over whatever the app renders below it, the
 * workspace or its gate. Modal: focus stays inside, and no keydown or keyup
 * reaches the app's shortcuts, which listen on the window, so nothing is
 * written to the workspace from underneath the run. Only the flow's own
 * buttons close it.
 */
export function ConversionFlowHost() {
  const repo = useRepo()
  const opened = useConversionFlowTarget()
  const target = opened?.userId === repo.user.id ? opened : null
  useEffect(() => {
    if (opened && !target) closeConversionFlow()
  }, [opened, target])
  // A hold shortcut armed just before the flow opened would fire under it:
  // the flow swallows the keyup that would cancel it.
  useEffect(() => {
    if (target) cancelArmedHolds()
  }, [target])
  if (!target) return null
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 overflow-y-auto bg-background"
          onEscapeKeyDown={preventDefault}
          onPointerDownOutside={preventDefault}
          onInteractOutside={preventDefault}
          onKeyDown={keepFromShortcuts}
          onKeyUp={keepFromShortcuts}
        >
          <DialogPrimitive.Title className="sr-only">Encrypt the workspace</DialogPrimitive.Title>
          <ErrorBoundary FallbackComponent={FlowCrashed}>
            {/* One run per workspace: switching the target starts a fresh flow. */}
            <HostedFlow key={target.workspaceId} target={target}/>
          </ErrorBoundary>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function HostedFlow({target}: {target: ConversionFlowTarget}) {
  const repo = useRepo()
  const localOnly = useIsLocalOnly()
  const unavailable = useMemo(() => conversionUnavailable(localOnly), [localOnly])
  const makeDeps = useCallback(
    (ui: ConversionUi, signal: AbortSignal) => conversionFlowDeps(repo, target.workspaceId, ui, signal),
    [repo, target.workspaceId],
  )
  return (
    <ConversionFlow
      workspaceName={target.workspaceName}
      unavailable={unavailable}
      makeDeps={makeDeps}
      onClose={closeConversionFlow}
    />
  )
}

function FlowCrashed({error}: FallbackProps) {
  return (
    <GateCard title="The conversion flow stopped" wide>
      <p className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p>
      <Explanation>The next run carries on from where the server is.</Explanation>
      <Button type="button" variant="secondary" onClick={closeConversionFlow}>Close</Button>
    </GateCard>
  )
}
