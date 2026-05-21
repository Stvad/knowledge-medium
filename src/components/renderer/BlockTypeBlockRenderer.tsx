/** Renderer for `'block-type'` blocks (user-defined-types Phase 1).
 *  Wraps the default block layout and replaces the content area with a
 *  type editor — label input, description textarea, and a refList
 *  picker for the property schemas this type lifts. Parallel in shape
 *  to PropertySchemaBlockRenderer. */

import { useCallback, useMemo, useState, type ChangeEvent } from 'react'
import { useHandle } from '@/hooks/block.ts'
import { ChangeScope } from '@/data/api'
import {
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
} from '@/data/properties.ts'
import { Input } from '@/components/ui/input.tsx'
import { Button } from '@/components/ui/button.tsx'
import { RefListPropertyEditor } from '@/components/propertyEditors/RefPropertyEditor.tsx'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'

const BlockTypeContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: d => d ? {
      id: d.id,
      properties: d.properties,
      deleted: d.deleted,
    } : undefined,
  })
  const readOnly = block.repo.isReadOnly

  const label = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[blockTypeLabelProp.name]
    return raw === undefined ? blockTypeLabelProp.defaultValue : blockTypeLabelProp.codec.decode(raw)
  }, [data])

  const description = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[blockTypeDescriptionProp.name]
    return raw === undefined ? blockTypeDescriptionProp.defaultValue : blockTypeDescriptionProp.codec.decode(raw)
  }, [data])

  const properties = useMemo<readonly string[]>(() => {
    if (!data) return []
    const raw = data.properties[blockTypePropertiesProp.name]
    return raw === undefined ? blockTypePropertiesProp.defaultValue : blockTypePropertiesProp.codec.decode(raw)
  }, [data])

  // Render-phase resync: when committed label changes (remote edit /
  // undo / sync), adopt it as the draft. Matches PropertySchemaBlockRenderer's
  // pattern.
  const [draftLabel, setDraftLabel] = useState(label)
  const [committedLabel, setCommittedLabel] = useState(label)
  if (label !== committedLabel) {
    setCommittedLabel(label)
    setDraftLabel(label)
  }

  const [draftDescription, setDraftDescription] = useState(description)
  const [committedDescription, setCommittedDescription] = useState(description)
  if (description !== committedDescription) {
    setCommittedDescription(description)
    setDraftDescription(description)
  }

  const writeLabel = useCallback(async (next: string) => {
    if (next === label) return
    await block.set(blockTypeLabelProp, next)
  }, [block, label])

  const writeDescription = useCallback(async (next: string) => {
    if (next === description) return
    await block.set(blockTypeDescriptionProp, next)
  }, [block, description])

  const writeProperties = useCallback(async (next: readonly string[]) => {
    await block.repo.tx(async tx => {
      await tx.setProperty(block.id, blockTypePropertiesProp, next)
    }, {scope: ChangeScope.BlockDefault, description: 'edit block-type properties'})
  }, [block])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const performDelete = useCallback(async () => {
    await block.repo.mutate.delete({id: block.id})
  }, [block])

  if (!data || data.deleted) return null

  return (
    <div className="w-full space-y-2 py-1">
      <div className="flex items-center gap-2">
        <Input
          value={draftLabel}
          placeholder="type label"
          readOnly={readOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftLabel(e.target.value)}
          onBlur={() => { void writeLabel(draftLabel.trim()) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="h-8 max-w-md text-base font-semibold"
        />
      </div>

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3">
        <label className="pt-1 text-xs font-semibold text-muted-foreground">Description</label>
        <textarea
          value={draftDescription}
          placeholder="What is this type for?"
          readOnly={readOnly}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraftDescription(e.target.value)}
          onBlur={() => { void writeDescription(draftDescription) }}
          className="min-h-[60px] w-full max-w-md rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3">
        <label className="pt-1 text-xs font-semibold text-muted-foreground">Properties</label>
        <div className="min-w-0">
          <RefListPropertyEditor
            value={properties}
            onChange={(next) => { void writeProperties(next) }}
            schema={blockTypePropertiesProp}
            block={block}
          />
        </div>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => {
              if (confirmDelete) {
                void performDelete()
                setConfirmDelete(false)
              } else {
                setConfirmDelete(true)
              }
            }}
          >
            {confirmDelete ? 'Really delete?' : 'Delete type'}
          </Button>
          {confirmDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
BlockTypeContentRenderer.displayName = 'BlockTypeContentRenderer'

/** Outer wrapper: keeps the default block layout (children,
 *  indentation, drag handle, focus chrome) and swaps in the
 *  type-editing content renderer. */
export const BlockTypeBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={BlockTypeContentRenderer}
      EditContentRenderer={BlockTypeContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      // Mirrors PropertySchemaBlockRenderer.canRender — peek may be null
      // on the very first render; useRenderer will rerun once the block
      // hydrates.
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes('block-type')
    },
    priority: () => 100,
  },
)
BlockTypeBlockRenderer.displayName = 'BlockTypeBlockRenderer'
