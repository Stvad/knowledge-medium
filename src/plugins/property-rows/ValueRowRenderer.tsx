/**
 * A scalar property's VALUE CHILD in the outline: renders the property type's
 * editor, the panel's own value cell, bound to the OWNER's property — so an
 * edit here is the panel's write (`writeProperty` → `setProperty`) of the
 * value the panel shows, not a text edit of the row. The value child stays an
 * ordinary block: its children nest under it and its bullet works as any
 * other's. List members are not this — see `isSingleValueProperty`.
 */
import { useMemo } from 'react'
import type { BlockRenderer, BlockRendererProps } from '@/types'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer'
import { writeProperty } from '@/components/propertyPanel/actions'
import { resolvePropertyModelRow } from '@/components/propertyPanel/model'
import { PropertyValueCell } from '@/components/propertyPanel/PropertyRow'
import { propertyEditorOverridesFacet } from '@/data/facets'
import { readValuePresets } from '@/data/valuePresetRegistry'
import type { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { useHandle } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { fieldRowDefinition, isSingleValueProperty, type FieldRowDefinition } from './fieldRow'

const EMPTY_PROPERTIES: Record<string, unknown> = {}

/** The field row a value child belongs to, when it is a scalar's value. */
const scalarValueOf = (block: Block): {owner: string; definition: FieldRowDefinition} | undefined => {
  const data = block.peek()
  if (!data?.parentId || data.isFieldForm === true) return undefined
  const fieldRow = block.repo.cache.getSnapshot(data.parentId)
  const definition = fieldRowDefinition(block.repo, fieldRow)
  if (!fieldRow?.parentId || !definition?.schema || !isSingleValueProperty(definition.schema)) return undefined
  return {owner: fieldRow.parentId, definition}
}

const ValueRowEditor: BlockRenderer = ({block}: BlockRendererProps) => {
  const schemas = usePropertySchemas()
  const runtime = useAppRuntime()
  const parentId = useHandle(block, {selector: row => row?.parentId ?? null})
  const ownerId = useHandle(block.repo.block(parentId ?? block.id), {selector: row => row?.parentId ?? null})
  const owner = block.repo.block(ownerId ?? block.id)
  const ownerProperties = useHandle(owner, {selector: row => row?.properties ?? EMPTY_PROPERTIES})
  const name = scalarValueOf(block)?.definition.name
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = readValuePresets(runtime)
  const row = useMemo(() => name === undefined ? null : resolvePropertyModelRow({
    blockId: owner.id,
    properties: ownerProperties,
    name,
    schemas,
    propertyDefinitions: block.repo.propertyDefinitions,
    typeDefinitions: block.repo.typeDefinitions,
    uis,
    presets,
  }), [block.repo, name, owner.id, ownerProperties, presets, schemas, uis])

  if (!row || ownerId === null) return null
  return (
    <div className="min-w-0" data-property-value-row="true" data-property-name={row.name}>
      <PropertyValueCell
        row={row}
        block={owner}
        onChange={next => { void writeProperty(owner, row.schema, next) }}
      />
    </div>
  )
}
ValueRowEditor.displayName = 'ValueRowEditor'

export const ValueRowRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={ValueRowEditor}
    EditContentRenderer={ValueRowEditor}
  />
)
ValueRowRenderer.displayName = 'ValueRowRenderer'
ValueRowRenderer.canRender = ({block}: BlockRendererProps): boolean => scalarValueOf(block) !== undefined
ValueRowRenderer.priority = () => 150
