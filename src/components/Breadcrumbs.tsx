import { Block } from '@/data/block.ts'
import { use, useMemo } from 'react'
import { BlockRenderer } from '@/types.ts'

export const Breadcrumbs = ({block, Renderer}: { block: Block, Renderer: BlockRenderer }) => {
  const parents = use(useMemo(() => block.parents(), [block.id]))

  if (parents.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground mb-2 overflow-x-auto py-1 flex-wrap">
      {parents.map((parent) => (
        <div key={parent.id} className="flex items-center min-w-0">
          <a
            href={`#${parent.id}`}
            className="no-underline cursor-pointer truncate max-w-full"
          >
            <div className="inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap
            [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit
            text-muted-foreground">
              <Renderer block={parent}/>
            </div>
          </a>
          <span className="mx-1 text-muted-foreground/50">›</span>
        </div>
      ))}
    </div>
  )
}
