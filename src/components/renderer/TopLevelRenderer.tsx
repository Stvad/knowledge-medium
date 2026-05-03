import { Header } from '@/components/Header.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useActionContext } from '@/shortcuts/useActionContext.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { memoize } from 'lodash'
import { ChangeScope } from '@/data/api'
import { Block } from '../../data/block'
import { useUserBlock } from '@/data/globalState.ts'
import { previousLoadTimeProp, currentLoadTimeProp } from '@/data/properties.ts'

// todo this is kind of a random place for this, I think a more principled
// way to do this is to have on-load hook and fire this there.
// Memoized per Block instance — fires once per render (memoize() with
// constant key returns the same Promise).
const updateLoadTimes = memoize((block: Block) => {
  void block.repo.tx(async tx => {
    const previous = block.peekProperty(currentLoadTimeProp) ?? 0
    await tx.setProperty(block.id, previousLoadTimeProp, previous)
    await tx.setProperty(block.id, currentLoadTimeProp, Date.now())
  }, {scope: ChangeScope.UiState, description: 'update load times'})
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

  useActionContext(ActionContextTypes.GLOBAL)

  return (
    <div className="min-h-screen h-screen bg-background text-foreground flex flex-col">
      <div className="container mx-0 max-w-full flex flex-col flex-grow overflow-hidden px-2">
        <Header/>
        <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
          <BlockComponent blockId={block.id}/>
        </NestedBlockContextProvider>
      </div>
    </div>
  )
}

TopLevelRenderer.canRender = ({context}: BlockRendererProps) => !!(context && context.topLevel && !context.panelId)
TopLevelRenderer.priority = () => 20
