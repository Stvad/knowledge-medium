/** Renderer for the Types page (user-defined-types Phase 1). Wraps the
 *  default page layout and surfaces a "New type" button. Children
 *  (existing block-type blocks) continue to render via their own
 *  BlockTypeBlockRenderer underneath. */

import { useCallback, useState } from 'react'
import { Plus } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import {
  BLOCK_TYPE_TYPE,
  PAGE_TYPE,
  TYPES_PAGE_TYPE,
} from '@/data/blockTypes'
import { blockTypeLabelProp } from '@/data/properties'
import { Button } from '@/components/ui/button.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'

const TypesPageContentRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const {block} = props
  const readOnly = block.repo.isReadOnly
  const [creating, setCreating] = useState(false)

  const createNewType = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      const childId: string = await block.repo.mutate.createChild({
        parentId: block.id,
        position: {kind: 'last'},
      })
      await block.repo.tx(async tx => {
        await block.repo.addTypeInTx(tx, childId, BLOCK_TYPE_TYPE, {})
        // PAGE_TYPE so the new type doubles as a navigable `[[label]]`
        // page — matches createTypeBlock's "type flow" pattern. Without
        // it, once the type claims its label as an alias (on first
        // naming, via writeBlockTypeLabel), `[[label]]` would resolve to
        // a non-page block and page-only code (`hasBlockType(PAGE_TYPE)`)
        // would treat it differently from a real page.
        await block.repo.addTypeInTx(tx, childId, PAGE_TYPE, {})
        // Seed an empty label so tryBuildType has something to report
        // and the BlockTypeBlockRenderer's input focuses on a defined
        // string. The type won't register with the runtime until the
        // user enters a non-empty label.
        await tx.setProperty(childId, blockTypeLabelProp, '')
      }, {scope: ChangeScope.BlockDefault, description: 'new block-type'})
    } finally {
      setCreating(false)
    }
  }, [block, creating])

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <MarkdownContentRenderer {...props} />
      {!readOnly && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 text-xs"
          disabled={creating}
          onClick={() => { void createNewType() }}
        >
          <Plus className="h-3.5 w-3.5" />
          {creating ? 'Creating…' : 'New type'}
        </Button>
      )}
    </div>
  )
}
TypesPageContentRenderer.displayName = 'TypesPageContentRenderer'

export const TypesPageBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={TypesPageContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes(TYPES_PAGE_TYPE)
    },
    priority: () => 100,
  },
)
TypesPageBlockRenderer.displayName = 'TypesPageBlockRenderer'
