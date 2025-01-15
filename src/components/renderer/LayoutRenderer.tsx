import { DocumentStateManagement } from '@/components/DocumentStateManagement.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'

export function LayoutRenderer({block, context}: BlockRendererProps) {

  // todo think about composition
  // I actually want the below thing to pick the renderer itself, but if my logic is
  // pick layout for top level, and then I go and try to pick renderer fo the block, by default
  // it will pick the layout renderer again recursively, which is not what I want
  /**
   * it needs to work with different data, hence context
   * I'm not sure if I love context approach.
   * It moves away from "all data is in the document"
   * But I can't like designate the block "top level" and then change that and pass it down
   * bc change would immediately propagate to higher level renderer
   *
   */
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto py-4">
        <DocumentStateManagement docUrl={block.id}/>
        <BlockComponent blockId={block.id} context={{...context, topLevel: false}}/>
      </div>
    </div>
  )
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) => context?.topLevel!!
LayoutRenderer.priority = () => 5
