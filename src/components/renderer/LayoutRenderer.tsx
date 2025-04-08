import { DocumentStateManagement } from '@/components/DocumentStateManagement.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { CommandPalette } from '@/components/CommandPalette.tsx'
import { useEffect } from 'react'
import { registerDefaultShortcuts } from '@/shortcuts/defaultShortcuts.ts'
import { useRepo } from '@/context/repo.tsx'
import { useActionContext } from '@/shortcuts/useActionContext.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

/**
 * This is like this to avoid re-rending on context changing bc of new object creation
 * Plausibly over-optimizing, but wanted to keep an example/reminder on this.
 */
const CONTEXT_OVERRIDE = {topLevel: false}

export function LayoutRenderer({block}: BlockRendererProps) {
  /**
   * todo think about composition
   * I actually want the below thing to pick the renderer itself, but if my logic is
   * pick layout for top level, and then I go and try to pick renderer fo the block, by default
   * it will pick the layout renderer again recursively, which is not what I want
   * it needs to work with different data, hence context
   *
   * I'm not sure if I love context approach.
   * It moves away from "all data is in the document"
   * But I can't like designate the block "top level" and then change that and pass it down
   * bc change would immediately propagate to higher level renderer
   *
   */

  const repo = useRepo()

  useEffect(() => {
    registerDefaultShortcuts({repo})
  }, [repo])

  useActionContext(ActionContextTypes.GLOBAL)

  return (
    <>
      <CommandPalette/>
      <div className="min-h-screen bg-background text-foreground">
        <div className="container mx-auto py-4">
          <DocumentStateManagement docUrl={block.id}/>
          <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
            <BlockComponent blockId={block.id}/>
          </NestedBlockContextProvider>
        </div>
      </div>
    </>
  )
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) => context?.topLevel!!
LayoutRenderer.priority = () => 5
