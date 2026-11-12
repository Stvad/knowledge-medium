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
import { isFieldValueChild, valueChildContentToEncoded } from '@/data/propertyChildren'
import { persistedJsonKey } from '@/data/internals/jsonCanonical'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer'
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
import { drawsPropertyRows, fieldRowDefinition, isSingleValueProperty } from './fieldRow'

const EMPTY_PROPERTIES: Record<string, unknown> = {}

/** The scalar property a value child is a value of, when its field row is
 *  recognized and the property is single-valued. */
const scalarOf = (block: Block): {fieldId: string; schema: AnyPropertySchema} | undefined => {
  const data = block.peek()
  if (!data?.parentId || data.isFieldForm === true) return undefined
  const fieldRow = block.repo.cache.getSnapshot(data.parentId)
  const definition = fieldRowDefinition(block.repo, fieldRow)
  if (!fieldRow?.parentId || !definition?.schema || !isSingleValueProperty(definition.schema)) return undefined
  return {fieldId: definition.fieldId, schema: definition.schema}
}

/** The id of the value child a write of this scalar lands on: the first value
 *  child of the owner's first field row for the definition, both in
 *  `(order_key, id)` order — the row `upsertFieldRow` keeps and
 *  `reconcileSingleValueChild` overwrites. Derived from the structural child
 *  lists, so it follows reorders, folds and arrivals. */
const useWriteTargetId = (repo: Block['repo'], ownerId: string | null, fieldId: string | undefined): string | null => {
  const fieldRowId = useHandle(repo.query.children({id: ownerId ?? '', hidePropertyChildren: false}), {
    selector: children => (children ?? []).find(child =>
      child.isFieldForm === true && child.referenceTargetId === fieldId)?.id ?? null,
  })
  return useHandle(repo.query.children({id: fieldRowId ?? '', hidePropertyChildren: false}), {
    selector: children => (children ?? []).find(isFieldValueChild)?.id ?? null,
  })
}

/** The owner's property this value child shows, when the child IS where a
 *  write of it lands ({@link useWriteTargetId}) and currently stores exactly
 *  the owner's cell value. `null` for any other value child — a sibling left
 *  divergent by concurrent offline edits, content its codec cannot read, a
 *  second field row's value — which then shows its own text as an ordinary
 *  block: the conflict the data layer keeps stays visible, and the editor never
 *  sits on one row while its write overwrites another. */
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
  const scalar = scalarOf(block)
  const schema = scalar?.schema
  const writeTargetId = useWriteTargetId(block.repo, ownerId, scalar?.fieldId)
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = readValuePresets(runtime)
  return useMemo(() => {
    if (!schema || !child || ownerId === null || writeTargetId !== block.id) return null
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
  }, [block.id, block.repo, child, owner, ownerId, ownerProperties, presets, schema, schemas, uis, writeTargetId])
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

export const ValueRowRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const fieldRowId = useContext(PropertyFieldRowContext)
  const parentId = useHandle(props.block, {selector: data => data?.parentId ?? null})
  // Only as a value in a field row drawn as a property row; anywhere else (a
  // backlink of the value's target) an ordinary block.
  return fieldRowId !== null && fieldRowId === parentId
    // Edit mode is the row's own text, as on any block — never the editor, so a
    // stray row edited into the owner's value is not swapped for an input
    // under the cursor.
    ? <DefaultBlockRenderer {...props} ContentRenderer={ValueRowContent}/>
    : <DefaultBlockRenderer {...props}/>
}
ValueRowRenderer.displayName = 'ValueRowRenderer'
ValueRowRenderer.canRender = ({block, context}: BlockRendererProps): boolean =>
  drawsPropertyRows(context) && scalarOf(block) !== undefined
ValueRowRenderer.priority = () => 150
