import { Header } from '@/components/Header.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { CommandPalette } from '@/components/CommandPalette.tsx'
import { useEffect } from 'react'
import { registerDefaultShortcuts } from '@/shortcuts/defaultShortcuts.ts'
import { useRepo } from '@/context/repo.tsx'
import { useActionContext } from '@/shortcuts/useActionContext.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { memoize } from 'lodash'
import { Block } from '@/data/block.ts'
import { useUserBlock } from '@/data/globalState.ts'
import { previousLoadTimeProp, currentLoadTimeProp } from '@/data/properties.ts'

// todo this is kind of a random place for this, I think a more principled way to do this is to have
// on-load hook and fire this there
// on the other hand it makes things harder to override? e.g. user can redefine top-level renderer
// how do they override the behavior in case of event based approach?
const updateLoadTimes = memoize((block: Block) => {
  block.change(doc => {
    const currentLoadTime = doc.properties.currentLoadTime?.value as number?? 0
    doc.properties.previousLoadTime = {...previousLoadTimeProp, value: currentLoadTime}
    doc.properties.currentLoadTime = {...currentLoadTimeProp, value: Date.now()}
  })
}, () => true)

/**
 * This is like this to avoid re-rending on context changing bc of new object creation
 * Plausibly over-optimizing, but wanted to keep an example/reminder on this.
 */
const CONTEXT_OVERRIDE = {topLevel: false}

export function TopLevelRenderer({block}: BlockRendererProps) {
  const userBlock = useUserBlock()
  updateLoadTimes(userBlock)
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
      <div className="min-h-screen h-screen bg-background text-foreground flex flex-col">
        <div className="container mx-0 max-w-full flex flex-col flex-grow overflow-hidden px-2">
          <Header/>
          <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
            <BlockComponent blockId={block.id}/>
          </NestedBlockContextProvider>
        </div>
      </div>
    </>
  )
}

TopLevelRenderer.canRender = ({context}: BlockRendererProps) => !!(context && context.topLevel && !context.panelId)
TopLevelRenderer.priority = () => 20
