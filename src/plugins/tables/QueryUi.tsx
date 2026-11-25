/** The parts of a table that exist only under a query: where the query is
 *  edited, its term errors, the host's children it does not select, and the
 *  hooks that hold the rows still while the table is being edited. */
import { useMemo, useState } from 'react'
import { BlockComponent } from '@/components/BlockComponent'
import { LazyBlockComponent } from '@/components/LazyBlockComponent'
import { useBlockContext } from '@/context/block'
import { PropertyRowListingContext } from '@/context/propertyDisplay'
import { definePropertyEditorOverride } from '@/data/api'
import type { Block } from '@/data/block'
import { useUIStateBlock } from '@/data/globalState'
import { focusBlock, focusedBlockLocationFromProperties, isEditingProp } from '@/data/properties'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle, useHandles } from '@/hooks/block'
import { useFocusPlacedChildIds } from '@/hooks/focusedChild'
import { openQueryValue } from './query/queryValue'
import { QueryText } from './query/QueryText'
import { useQueryFieldId, type TableQuery } from './query/source'
import { queryProp } from './schema'
import { notesInScope } from './registry'

/** Is a block in this render scope being edited? */
export const useEditingIn = (uiStateBlock: Block, renderScopeId: string): boolean =>
  useHandle(uiStateBlock, {selector: data => {
    if (!data || !safeDecodeRowProperty(data, isEditingProp)) return false
    const focusedScope = focusedBlockLocationFromProperties(data.properties)?.renderScopeId
    return focusedScope === renderScopeId || (focusedScope !== undefined &&
      notesInScope(focusedScope)?.grid.renderScopeId === renderScopeId)
  }})

/** The ids whose blocks still exist: a row made here and then deleted leaves the grid. */
export const useLiveRows = (repo: Block['repo'], ids: readonly string[]): readonly string[] => {
  const blocks = useMemo(() => ids.map(id => repo.block(id)), [ids, repo])
  const data = useHandles(blocks)
  return useMemo(() => ids.filter((_, index) => data[index] !== null), [data, ids])
}

/** `value`, or the last one seen while `hold` was false. Nothing is held
 *  before a value has arrived. */
export const useHeldWhile = <T,>(value: T | undefined, hold: boolean): T | undefined => {
  const [held, setHeld] = useState(value)
  const holding = hold && held !== undefined
  if (!holding && held !== value) setHeld(value)
  return holding ? held : value
}

/** Each term the query could not compile, with its text: the rest still runs. */
export const QueryErrors = ({query}: {query: TableQuery}) => {
  const {errors} = query.parsed
  if (errors.length === 0) return null
  return (
    <ul data-table-query-errors="true" className="py-1 text-xs text-destructive">
      {errors.map(error => (
        <li key={`${error.start}:${error.message}`} data-table-query-error={error.message}>
          <code className="rounded bg-muted px-1">{query.text.slice(error.start, error.end)}</code> {error.message}
        </li>
      ))}
    </ul>
  )
}

export const queryPropertyUi = definePropertyEditorOverride(queryProp, {InlineEditor: QueryText})

/** Adds the query property with an empty value and opens it for editing. */
export const AddQueryButton = ({host, parentRenderScopeId}: {host: Block; parentRenderScopeId: string}) => {
  const uiStateBlock = useUIStateBlock()
  const fieldId = useQueryFieldId(host.repo)
  if (!fieldId) return null
  const add = async () => {
    const valueId = await openQueryValue(host.repo, host.id, fieldId)
    await focusBlock(uiStateBlock, valueId, {edit: true, renderScopeId: parentRenderScopeId})
  }
  return <button type="button" data-table-add-query="true" className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    onClick={() => { void add().catch(error => console.error('[tables] add query failed', error)) }}>+ Query</button>
}

/** The query's field rows, drawn as the outline draws them, in the host's own
 *  scope: the query is edited there, as an ordinary value block. */
export const QueryFields = ({host}: {host: Block}) => {
  const fieldId = useQueryFieldId(host.repo)
  return fieldId ? <QueryFieldRows host={host} fieldId={fieldId}/> : null
}

const QueryFieldRows = ({host, fieldId}: {host: Block; fieldId: string}) => {
  const fieldRows = useHandle(host.repo.query.propertyRows({ownerId: host.id, fieldId}),
    {selector: rows => rows?.fields.map(({field}) => field.id) ?? []})
  if (fieldRows.length === 0) return null
  return (
    <PropertyRowListingContext value={host.id}>
      <div data-table-query-fields="true">
        {fieldRows.map(id => <BlockComponent key={id} blockId={id}/>)}
      </div>
    </PropertyRowListingContext>
  )
}

const NO_IDS: string[] = []

/** The host's children the query does not select, in outline order, with the
 *  focused one where the cache has it. A focused field row the listing leaves
 *  out is the query's own, which `QueryFields` draws. */
export const useOutsideQueryIds = (
  host: Block, renderScopeId: unknown, rows: readonly string[], viewIds: readonly string[],
): string[] => {
  // Every child, as the outline lists them: a capped window would hide the ones past it.
  const children = useHandle(host.repo.query.childIds({id: host.id, propertyChildren: 'none'}), {selector: ids => ids})
  const {childIds, listed, focusedChild} = useFocusPlacedChildIds(host, renderScopeId, children ?? NO_IDS)
  const drawn = new Set([...rows, ...viewIds])
  if (focusedChild?.isFieldForm && !listed.includes(focusedChild.id)) drawn.add(focusedChild.id)
  return childIds.filter(id => !drawn.has(id))
}

/** Under a query, the host's children the query does not select, drawn as
 *  ordinary outline below the grid: nothing under a table is invisible. */
export const OutsideQuery = ({host, viewIds, rows}: {host: Block; viewIds: readonly string[]; rows: readonly string[]}) => {
  const {renderScopeId} = useBlockContext()
  const outside = useOutsideQueryIds(host, renderScopeId, rows, viewIds)
  if (outside.length === 0) return null
  return (
    <div data-table-outside-query="true" className="mt-1">
      <p className="py-1 text-xs text-muted-foreground">Under this table, not selected by the query</p>
      {outside.map(id => <LazyBlockComponent key={id} blockId={id} renderScopeId={renderScopeId}/>)}
    </div>
  )
}
