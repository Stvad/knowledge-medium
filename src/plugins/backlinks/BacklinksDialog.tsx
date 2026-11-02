import {Suspense, useId} from 'react'
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {BlockContextProvider} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import type {DialogContextProps} from '@/utils/dialogs.js'
import {surfaceRenderScopeId} from '@/utils/renderScope.js'
import {LinkedReferences} from './LinkedReferences.tsx'

/** A fresh instance of the existing list, including when its panel instance
 *  is collapsed or its target is already focal. */
export const BacklinksDialog = ({blockId, panelId, cancel}: {blockId: string; panelId: string} & DialogContextProps<void>) => {
  const repo = useRepo()
  const instanceId = useId()
  const renderScopeId = surfaceRenderScopeId('backlinks-dialog', blockId, instanceId)
  return (
    <Dialog open onOpenChange={cancel}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Linked References</DialogTitle>
        </DialogHeader>
        <BlockContextProvider initialValue={{isNestedSurface: true, layoutBoundary: false, panelId, renderScopeId, scopeRootId: blockId}}>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading references…</p>}>
            <LinkedReferences block={repo.block(blockId)}/>
          </Suspense>
        </BlockContextProvider>
      </DialogContent>
    </Dialog>
  )
}
