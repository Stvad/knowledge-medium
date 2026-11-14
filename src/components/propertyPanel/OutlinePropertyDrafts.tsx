import {useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode} from 'react'
import type {Block} from '@/data/block'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {focusBlock, getBlockTypes} from '@/data/properties'
import {useFocusWithin} from '@/hooks/focusedChild'
import {useUIStateBlock} from '@/data/globalState'
import {useHandle} from '@/hooks/block'
import {useTypes} from '@/hooks/typeRegistry'
import {usePropertySchemas} from '@/hooks/propertySchemas'
import {useBlockContext} from '@/context/block'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import type {PropertyDisplayMode} from '@/data/propertyDisplayMode'
import {outlineSkippedFieldIds, type PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import {commitInlineProperty, expectedPropertyPosition} from '@/data/inlineProperty'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {navigatePendingProperty} from './pendingPropertyNavigation'
import {PendingPropertyRow} from './PendingPropertyRow'
import {outlinePropertySession, type PendingOutlineProperty} from './outlinePropertySession'

const skippedByRegistry = new WeakMap<PropertyDefinitionRegistrySnapshot, ReadonlySet<string>>()
const skippedFields = (registry: PropertyDefinitionRegistrySnapshot): ReadonlySet<string> => {
  let skipped = skippedByRegistry.get(registry)
  if (!skipped) {
    skipped = outlineSkippedFieldIds(registry)
    skippedByRegistry.set(registry, skipped)
  }
  return skipped
}

export const useOutlinePropertySession = () => {
  const ui = useUIStateBlock()
  const {renderScopeId} = useBlockContext()
  return outlinePropertySession(ui, renderScopeId)
}

export const useOutlinePropertyListing = (parent: Block) => {
  const session = useOutlinePropertySession()
  return useSyncExternalStore(session.subscribe, () => session.snapshot(parent.id))
}

export function OutlinePropertyDrafts({owner, mode, children}: {
  owner: Block; mode: PropertyDisplayMode; children: readonly {id: string; element: ReactNode}[]
}) {
  const state = useOutlinePropertyListing(owner)
  const {renderScopeId} = useBlockContext()
  const scope = useContext(PropertyDisplayScopeContext)
  const renderDraft = (draft: PendingOutlineProperty, autoFocus: boolean) => <Draft
    key={`pending:${draft.schema.fieldId}`} draft={draft} owner={owner.repo.block(draft.ownerId)}
    autoFocus={autoFocus} scope={renderScopeId}/>
  const rows = children.map(child => child.element)
  for (const draft of state.pending) {
    const at = draft.orderKey === undefined ? -1 : children.findIndex(child => {
      const row = owner.repo.block(child.id).peek()
      return row !== undefined && row !== null && row.orderKey > draft.orderKey!
    })
    rows.splice(at < 0 ? rows.length : at, 0, renderDraft(draft, true))
  }
  if (scope.childBacked && mode !== 'none' && !owner.repo.isReadOnly) {
    rows.splice(expectedPropertyPosition(rows.length), 0,
      <ExpectedPropertyDrafts key="expected-properties" owner={owner} mode={mode} pending={state.pending}/> )
  }
  return <>
    {(state.revealed.length > 0 || state.pending.some(draft => draft.ownerId === owner.id)) &&
      <SessionRetention owner={owner}/>}
    {rows}
  </>
}

function SessionRetention({owner}: {owner: Block}) {
  const session = useOutlinePropertySession()
  const {renderScopeId} = useBlockContext()
  const within = useFocusWithin(owner, renderScopeId)
  useEffect(() => {
    if (within === false) session.clearOwner(owner.id)
  }, [within, owner.id, session])
  return null
}

function ExpectedPropertyDrafts({owner, mode, pending}: {
  owner: Block; mode: PropertyDisplayMode; pending: readonly PendingOutlineProperty[]
}) {
  const {renderScopeId} = useBlockContext()
  const schemas = usePropertySchemas()
  const types = useTypes()
  const data = useHandle(owner, {selector: row => row})
  // Existence check only; navigation uses the drawn listing, never this query.
  const stored = useHandle(owner.repo.query.children({id: owner.id, propertyChildren: 'all'}), {selector: rows => rows})
  if (!data || !stored) return null
  const ownerTypes = getBlockTypes(data)
  if (ownerTypes.length === 0) return null
  const resolver = owner.repo.propertySchemaResolverFor(data.workspaceId)
  const skipped = mode === 'non-hidden' && owner.repo.propertyDefinitions ? skippedFields(owner.repo.propertyDefinitions) : null
  const seen = new Set(pending.map(item => item.schema.fieldId))
  const expected: PendingOutlineProperty[] = []
  for (const typeId of ownerTypes) {
    for (const declaration of types.get(typeId)?.properties ?? []) {
      const active = schemas.get(declaration.name)
      if (!active) continue
      const result = resolver.resolve(active.name)
      if (result.status !== 'resolved') continue
      const schema = result.schema as AnyResolvedPropertySchema
      if (seen.has(schema.fieldId) || skipped?.has(schema.fieldId) ||
        stored.some(row => row.isFieldForm && row.referenceTargetId === schema.fieldId) ||
        Object.hasOwn(data.properties, schema.name)) continue
      seen.add(schema.fieldId)
      expected.push({schema, ownerId: owner.id, parentId: owner.id})
    }
  }
  return expected.map(draft => <Draft key={draft.schema.fieldId} draft={draft}
    owner={owner} autoFocus={false} scope={renderScopeId}/> )
}

function Draft({draft, owner, autoFocus, scope}: {draft: PendingOutlineProperty; owner: Block; autoFocus: boolean; scope: unknown}) {
  const session = useOutlinePropertySession()
  const ui = useUIStateBlock()
  const surface = useRef<HTMLDivElement>(null)
  const blurTarget = useRef<Node | null>(null)
  const attempt = useRef(0)
  const remove = useCallback(() => session.remove(draft.parentId, draft.schema.fieldId), [draft, session])
  const renderScopeId = typeof scope === 'string' ? scope : undefined
  return <div ref={surface} data-pending-property-scope-id={renderScopeId} onFocusCapture={() => {
    blurTarget.current = null
    void focusBlock(ui, owner.id, {edit: false, renderScopeId})
  }} onBlurCapture={event => { blurTarget.current = event.relatedTarget as Node | null }}>
    <PendingPropertyRow owner={owner} schema={draft.schema} autoFocus={autoFocus}
    onCancel={() => { attempt.current++; remove() }}
    onNavigate={direction => {
      if (surface.current && renderScopeId) void navigatePendingProperty(surface.current, renderScopeId, direction, ui)
    }}
    onCommit={async content => {
      const currentAttempt = ++attempt.current
      const inputSurface = surface.current
      let ownerSurface = inputSurface?.parentElement ?? null
      while (ownerSurface && ownerSurface.dataset.blockId !== owner.id) ownerSurface = ownerSurface.parentElement
      let focusAllowed = inputSurface?.contains(document.activeElement) ?? false
      let revealAllowed = !!(ownerSurface?.contains(document.activeElement) || ownerSurface?.contains(blurTarget.current))
      const followInteraction = (event: Event) => {
        const target = event.target as Node | null
        if (!inputSurface?.contains(target)) focusAllowed = false
        if (!ownerSurface?.contains(target)) revealAllowed = false
      }
      document.addEventListener('pointerdown', followInteraction, true)
      document.addEventListener('focusin', followInteraction, true)
      try {
        const target = await commitInlineProperty(owner, draft, content)
        if (!target) return remove()
        await Promise.all([owner.repo.block(target.fieldRowId).load(), owner.repo.block(target.valueId).load()])
        if (attempt.current !== currentAttempt || !ownerSurface?.isConnected) return
        if (revealAllowed) session.reveal(owner.id, target.fieldRowId)
        remove()
        if (focusAllowed) await enterEditModeForBlock(owner.repo.block(target.valueId), ui, renderScopeId, {start: content.length})
      } finally {
        document.removeEventListener('pointerdown', followInteraction, true)
        document.removeEventListener('focusin', followInteraction, true)
      }
    }}/></div>
}
