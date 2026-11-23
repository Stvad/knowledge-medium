import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { hasSourceContent } from '@/data/blockTypes'
import { childrenViewFor, listingSurfaceOf, propertyDisplayChildrenView, type ListingSurface } from '@/data/childrenView'
import { createChild, createSiblingAbove, createSiblingBelow, liveChildAt, split, type InsertPosition as StoredInsertPosition, type SplitPlacement } from '@/data/mutators'
import type { SurfaceCarrier } from '@/data/outlineSurface'
import { outdentDrawnBlock, structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import { nestedWriteLocation } from '@/utils/drawnWalk'

export type InsertGesture =
  | {kind: 'above' | 'below' | 'enter' | 'empty-enter'}
  | {
    kind: 'split'
    /** Save and re-arm the live editor around the transactional split. */
    write(placement: SplitPlacement, commit: (before: string, after: string) => Promise<string | null>): Promise<string | null>
  }

export type InsertPosition = 'first' | 'last' | 'before' | 'after'

export interface ChildrenInsertRequest {
  block: Block
  data: BlockData
  surface: ListingSurface
  gesture: InsertGesture['kind']
  /** The nested editing root the block's ancestry must still reach. */
  boundaryId?: string
  /** First or last child of the block, or a sibling before or after it. */
  position: InsertPosition
}

export interface InsertedBlock {
  id: string
  renderScopeId: string | undefined
  /** False when the destination draws the block without an editor for its text. */
  edit?: boolean
}

/** The view may return a created ID, specify a different focus surface, or ask the outline to place the block. */
export type ChildrenInsertDecision = string | InsertedBlock | {position: InsertPosition; renderScopeId?: string}

async function childPositionFor(request: ChildrenInsertRequest, renderScopeId: string | undefined): Promise<StoredInsertPosition | undefined> {
  const {block, data, position} = request
  if (position !== 'first' && position !== 'last') return undefined
  const ctx = {parent: block, data, surface: {...request.surface, renderScopeId}}
  const view = childrenViewFor(ctx)
  if (view === propertyDisplayChildrenView) return {kind: position}
  const children = await view.read(ctx).load()
  const ownMember = (child: typeof children[number]): child is string => typeof child === 'string'
  const siblingId = position === 'first' ? children.find(ownMember) : children.findLast(ownMember)
  return siblingId === undefined ? {kind: position} : {kind: position === 'first' ? 'before' : 'after', siblingId}
}

async function insertInDataOrder(
  request: ChildrenInsertRequest,
  gesture: InsertGesture,
  renderScopeId = request.surface.renderScopeId,
): Promise<InsertedBlock | null> {
  const {block, data, position, boundaryId} = request
  const {repo, id} = block
  const childPosition = await childPositionFor(request, renderScopeId)
  const childAnchorId = childPosition && 'siblingId' in childPosition ? childPosition.siblingId : undefined
  const currentAtPosition = async (tx: Tx) => {
    const current = await liveChildAt(tx, id, data.parentId, boundaryId)
    if (!current) return null
    if (childAnchorId !== undefined && !await liveChildAt(tx, childAnchorId, id)) return null
    return current
  }
  const options = {scope: ChangeScope.BlockDefault, description: gesture.kind === 'split' ? `split ${id}` : `insert at ${id}`}
  if (gesture.kind === 'split') {
    if (position === 'after' || position === 'last') return null
    const placement = position === 'first' ? 'firstChild' : 'siblingBefore'
    const newId = await gesture.write(placement, (before, after) => repo.tx(async tx => {
      const current = await currentAtPosition(tx)
      if (!current || hasSourceContent(current)) return null
      return tx.run(split, {id, before, after, placement, firstChildBeforeId: childAnchorId})
    }, options))
    return newId === null ? null : {id: position === 'first' ? newId : id, renderScopeId}
  }

  const newId = await repo.tx(async tx => {
    if (!await currentAtPosition(tx)) return null
    if (childPosition) return tx.run(createChild, {parentId: id, position: childPosition, revealParent: true})
    return tx.run(position === 'before' ? createSiblingAbove : createSiblingBelow, {siblingId: id})
  }, options)
  return newId === null ? null : {id: newId, renderScopeId}
}

async function insertWithView(parent: Block, surface: ListingSurface, request: ChildrenInsertRequest, gesture: InsertGesture, projected: boolean) {
  const data = parent.peek() ?? await parent.load()
  if (!data) return undefined
  const ctx = {parent, data, surface}
  const answer = await childrenViewFor(ctx).insert?.(ctx, request)
  if (typeof answer === 'string') return {id: answer, renderScopeId: request.surface.renderScopeId}
  if (answer && 'position' in answer) {
    const {position, renderScopeId} = answer
    if (projected && (gesture.kind === 'split' || position === 'before' || position === 'after')) return null
    return insertInDataOrder({...request, position}, gesture, renderScopeId)
  }
  return answer
}

function positionFor(gesture: InsertGesture['kind'], atRoot: boolean, showsChildren: boolean): InsertPosition {
  if (atRoot) return 'first'
  if (gesture === 'above' || gesture === 'split') return 'before'
  return showsChildren ? 'first' : 'after'
}

export async function insertDrawnBlock(block: Block, carrier: SurfaceCarrier, gesture: InsertGesture): Promise<InsertedBlock | null> {
  const {repo} = block
  const data = block.peek() ?? await block.load()
  if (!data || repo.isReadOnly) return null
  if (gesture.kind === 'split' && hasSourceContent(data)) return null
  const declaration = await nestedWriteLocation(block, carrier.renderScopeId)
  if (declaration === null) return null
  const direct = declaration?.memberId === block.id ? declaration : undefined
  const projected = direct !== undefined && (direct.nested.order === 'query' || direct.parent.block.id !== data.parentId)
  const scopeRootId = direct?.boundaryId ?? carrier.scopeRootId
  const surface = listingSurfaceOf({...carrier, scopeRootId})
  const policy = await structuralEditPolicyForBlock(block, surface)
  const position = positionFor(gesture.kind, policy.isScopeRoot, policy.hasUncollapsedChildren)
  const request = {block, data, surface, gesture: gesture.kind, position, boundaryId: declaration?.boundaryId} satisfies ChildrenInsertRequest

  // The owner can place a nested member beside the others even when editing the member is scoped to its own subtree.
  if (declaration && (direct || policy.isScopeRoot)) {
    const nestedPosition = direct ? positionFor(gesture.kind, false, policy.hasUncollapsedChildren) : position
    const result = await insertWithView(declaration.parent.block, declaration.parent.surface, {...request, position: nestedPosition}, gesture, projected)
    if (result !== undefined) return result
  }
  if (projected && gesture.kind === 'split') return null

  const parent = position === 'first' ? block : data.parentId === null ? null : repo.block(data.parentId)
  if (parent) {
    const result = await insertWithView(parent, surface, request, gesture, projected)
    if (result !== undefined) return result
  }
  if (gesture.kind === 'empty-enter' && position === 'after' && policy.canOutdent) {
    const moved = await outdentDrawnBlock(block, surface, data.parentId)
    if (moved !== false) return null
  }
  return insertInDataOrder(request, gesture)
}
