/**
 * A scalar property's VALUE CHILD in the outline: renders the property type's
 * editor, the panel's own value cell, bound to the OWNER's property — so an
 * edit here is the panel's write (`writeProperty` → `setProperty`) of the
 * value the panel shows, not a text edit of the row — but only while the child
 * IS that value (`useOwnersValue`); otherwise it shows its own text. Either way
 * the value child is an ordinary block: its children nest under it and its
 * bullet works as any other's. List members never get the editor — see
 * `isSingleValueProperty`.
 */
import { useContext, useMemo } from 'react'
import { PropertyFieldRowContext } from '@/context/propertyDisplay'
import type { BlockRenderer, BlockRendererProps } from '@/types'
import type { AnyPropertySchema } from '@/data/api'
import { valueChildContentToEncoded } from '@/data/propertyChildren'
import { persistedJsonKey } from '@/data/internals/jsonCanonical'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer'
import { writeProperty } from '@/components/propertyPanel/actions'
import { resolvePropertyModelRow, type PropertyPanelModelRow } from '@/components/propertyPanel/model'
import { PropertyValueCell } from '@/components/propertyPanel/PropertyRow'
import { propertyEditorOverridesFacet } from '@/data/facets'
import { readValuePresets } from '@/data/valuePresetRegistry'
import type { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { useHandle } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { drawsPropertyRows, fieldRowDefinition, isSingleValueProperty, type FieldRowDefinition } from './fieldRow'

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

/** The owner's property this value child shows, when the child IS that value:
 *  its own content stores exactly what the owner's cell holds. `null` for a
 *  child that is not — a sibling left divergent by concurrent offline edits,
 *  or content its codec cannot read — which then shows its own text as an
 *  ordinary block, so the conflict the data layer keeps stays visible and an
 *  edit lands on the row the user is looking at. */
const useOwnersValue = (block: Block): {owner: Block; row: PropertyPanelModelRow} | null => {
  const schemas = usePropertySchemas()
  const runtime = useAppRuntime()
  const child = useHandle(block, {
    selector: data => data ? {parentId: data.parentId, content: data.content} : null,
  })
  const ownerId = useHandle(block.repo.block(child?.parentId ?? block.id), {
    selector: data => data?.parentId ?? null,
  })
  const owner = block.repo.block(ownerId ?? block.id)
  const ownerProperties = useHandle(owner, {selector: data => data?.properties ?? EMPTY_PROPERTIES})
  const schema = scalarValueOf(block)?.definition.schema
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = readValuePresets(runtime)
  return useMemo(() => {
    if (!schema || !child || ownerId === null) return null
    if (!Object.hasOwn(ownerProperties, schema.name)) return null
    if (storedFormOfContent(schema, child.content) !== persistedJsonKey(ownerProperties[schema.name])) return null
    const row = resolvePropertyModelRow({
      blockId: owner.id,
      properties: ownerProperties,
      name: schema.name,
      schemas,
      propertyDefinitions: block.repo.propertyDefinitions,
      typeDefinitions: block.repo.typeDefinitions,
      uis,
      presets,
    })
    return row ? {owner, row} : null
  }, [block.repo, child, owner, ownerId, ownerProperties, presets, schema, schemas, uis])
}

/** The persisted form of a value child's content, or `undefined` when its
 *  codec cannot read it. */
const storedFormOfContent = (schema: AnyPropertySchema, content: string): string | undefined => {
  try {
    return persistedJsonKey(valueChildContentToEncoded(schema, content))
  } catch {
    return undefined
  }
}

const ownersValueRenderer = (Fallback: BlockRenderer): BlockRenderer => {
  const Renderer: BlockRenderer = ({block}: BlockRendererProps) => {
    const value = useOwnersValue(block)
    if (!value) return <Fallback block={block}/>
    const {owner, row} = value
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
  Renderer.displayName = `OwnersValue(${Fallback.displayName ?? Fallback.name})`
  return Renderer
}

const ValueRowContent = ownersValueRenderer(MarkdownContentRenderer)
const ValueRowEditContent = ownersValueRenderer(CodeMirrorContentRenderer)

export const ValueRowRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const fieldRowId = useContext(PropertyFieldRowContext)
  const parentId = useHandle(props.block, {selector: data => data?.parentId ?? null})
  // Only as a value in a field row drawn as a property row; anywhere else (a
  // backlink of the value's target) an ordinary block.
  return fieldRowId !== null && fieldRowId === parentId
    ? <DefaultBlockRenderer {...props} ContentRenderer={ValueRowContent} EditContentRenderer={ValueRowEditContent}/>
    : <DefaultBlockRenderer {...props}/>
}
ValueRowRenderer.displayName = 'ValueRowRenderer'
ValueRowRenderer.canRender = ({block, context}: BlockRendererProps): boolean =>
  drawsPropertyRows(context) && scalarValueOf(block) !== undefined
ValueRowRenderer.priority = () => 150
