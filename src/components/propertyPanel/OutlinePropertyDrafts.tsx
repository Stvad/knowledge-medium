import {useContext, useEffect, useRef, useSyncExternalStore, type ReactNode} from 'react'
import type {Block} from '@/data/block'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {focusBlock, getBlockTypes} from '@/data/properties'
import {useFocusWithin, focusIsWithin} from '@/hooks/focusedChild'
import {useUIStateBlock} from '@/data/globalState'
import {useHandle} from '@/hooks/block'
import {useTypes} from '@/hooks/typeRegistry'
import {usePropertySchemas} from '@/hooks/propertySchemas'
import {useBlockContext} from '@/context/block'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import type {PropertyDisplayMode} from '@/data/propertyDisplayMode'
import {outlineSkippedFieldIds, type PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import {expectedPropertyPosition} from '@/data/inlineProperty'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {navigatePendingProperty} from './pendingPropertyNavigation'
import {showError} from '@/utils/toast'
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

export const useOutlinePropertyOwner = (owner: Block) => {
  const session = useOutlinePropertySession()
  useEffect(() => {
    session.mountOwner(owner.id)
    return () => {
      for (const draft of session.disposeOwner(owner.id)) {
        if (draft.text && !draft.committing) showError(`Unsaved value for ${draft.schema.name}: ${JSON.stringify(draft.text)}`)
      }
    }
  }, [owner.id, session])
}

export const useOutlinePropertyExpansion = (owner: Block): boolean => {
  const session = useOutlinePropertySession()
  return useSyncExternalStore(session.subscribe, () => session.isExpanded(owner.id))
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
  for (const draft of state.pending.filter(item => !item.ghost)) {
    const at = draft.orderKey === undefined ? -1 : children.findIndex(child => {
      const row = owner.repo.block(child.id).peek()
      return row !== undefined && row !== null && row.orderKey > draft.orderKey!
    })
    rows.splice(at < 0 ? rows.length : at, 0, renderDraft(draft, draft.autoFocus !== false))
  }
  if (scope.childBacked && !owner.repo.isReadOnly && (mode !== 'none' || state.pending.some(draft => draft.ghost))) {
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
  const revision = useSyncExternalStore(session.subscribe, session.snapshotRevision)
  useEffect(() => {
    if (within === false) session.clearOwner(owner.id)
  }, [within, revision, owner.id, session])
  return null
}

function ExpectedPropertyDrafts({owner, mode, pending}: {
  owner: Block; mode: PropertyDisplayMode; pending: readonly PendingOutlineProperty[]
}) {
  const ownerTypes = useHandle(owner, {selector: row => row ? getBlockTypes(row) : []})
  const {renderScopeId} = useBlockContext()
  if (mode === 'none' || ownerTypes.length === 0) return pending.filter(draft => draft.ghost).map(draft =>
    <Draft key={draft.schema.fieldId} draft={draft} owner={owner} autoFocus={true} scope={renderScopeId}/>)
  return <ExpectedTypedPropertyDrafts owner={owner} mode={mode} pending={pending} ownerTypes={ownerTypes}/>
}

function ExpectedTypedPropertyDrafts({owner, mode, pending, ownerTypes}: {
  owner: Block; mode: PropertyDisplayMode; pending: readonly PendingOutlineProperty[]; ownerTypes: readonly string[]
}) {
  const {renderScopeId} = useBlockContext()
  const schemas = usePropertySchemas()
  const types = useTypes()
  const data = useHandle(owner, {selector: row => row})
  // Existence check only; navigation uses the drawn listing, never this query.
  const stored = useHandle(owner.repo.query.children({id: owner.id, propertyChildren: 'all'}), {selector: rows => rows})
  if (!data || !stored) return null
  const resolver = owner.repo.propertySchemaResolverFor(data.workspaceId)
  const skipped = mode === 'non-hidden' && owner.repo.propertyDefinitions ? skippedFields(owner.repo.propertyDefinitions) : null
  const seen = new Set(pending.filter(item => !item.ghost).map(item => item.schema.fieldId))
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
      expected.push(pending.find(item => item.schema.fieldId === schema.fieldId) ?? {schema, ownerId: owner.id, parentId: owner.id, ghost: true})
    }
  }
  expected.push(...pending.filter(draft => draft.ghost && !seen.has(draft.schema.fieldId)))
  return expected.map(draft => <Draft key={draft.schema.fieldId} draft={draft}
    owner={owner} autoFocus={false} scope={renderScopeId}/> )
}

function Draft({draft, owner, autoFocus, scope}: {draft: PendingOutlineProperty; owner: Block; autoFocus: boolean; scope: unknown}) {
  const session = useOutlinePropertySession()
  const ui = useUIStateBlock()
  const surface = useRef<HTMLDivElement>(null)
  const renderScopeId = typeof scope === 'string' ? scope : undefined
  const within = useFocusWithin(owner, renderScopeId)
  const commit = async () => {
    const inputSurface = surface.current
    let ownerSurface = inputSurface?.parentElement ?? null
    while (ownerSurface && ownerSurface.dataset.blockId !== owner.id) ownerSurface = ownerSurface.parentElement
    let focusAllowed = inputSurface?.contains(document.activeElement) ?? false
    const followInteraction = (event: Event) => {
      if (!inputSurface?.contains(event.target as Node | null)) focusAllowed = false
    }
    document.addEventListener('pointerdown', followInteraction, true)
    document.addEventListener('focusin', followInteraction, true)
    try {
      const target = await session.submit(owner, draft)
      if (!target) return
      await Promise.all([owner.repo.block(target.fieldRowId).load(), owner.repo.block(target.valueId).load()])
      if (!ownerSurface?.isConnected) return
      if (focusIsWithin(ui, owner.id, renderScopeId)) session.reveal(owner.id, target.fieldRowId)
      if (focusAllowed) await enterEditModeForBlock(owner.repo.block(target.valueId), ui, renderScopeId, {start: (draft.text ?? '').length})
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save property value'
      showError(`${message} — ${draft.schema.name}: ${JSON.stringify(draft.text ?? '')}`)
    } finally {
      document.removeEventListener('pointerdown', followInteraction, true)
      document.removeEventListener('focusin', followInteraction, true)
    }
  }
  return <div ref={surface} data-pending-property-scope-id={renderScopeId} onFocusCapture={() => {
    void focusBlock(ui, owner.id, {edit: false, renderScopeId})
  }}>
    <PendingPropertyRow owner={owner} schema={draft.schema} autoFocus={autoFocus && within === true}
      draft={draft.text ?? ''} committing={draft.committing ?? false}
      onDraftChange={text => session.setText(draft, text)}
      onCancel={() => session.remove(draft.parentId, draft.schema.fieldId)}
      onNavigate={direction => {
        if (surface.current && renderScopeId) void navigatePendingProperty(surface.current, renderScopeId, direction, ui)
      }} onCommit={() => { void commit() }}/>
  </div>
}
