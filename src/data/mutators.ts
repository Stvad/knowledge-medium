/**
 * Kernel tree mutators (spec §13.3). Each is registered as a `Mutator`
 * via `defineMutator` and dispatched from `repo.mutate.X(args)` or
 * `repo.run('name', args)`.
 *
 * All mutators run inside a `repo.tx` (the dispatch wrapper opens one
 * automatically with the mutator's scope) and use the public Tx
 * primitives plus the tree CTEs from stage 1.3. Order keys are
 * computed via `fractional-indexing-jittered` (§4.7 / §16.12).
 *
 * Subtree handling note: legacy `Block.delete()` cascaded a soft-delete
 * across descendants; the new `delete` mutator preserves that behavior
 * via DFS over `tx.childrenOf`. Walking by repeated child-queries keeps
 * us on the public Tx surface (no raw SQL needed inside mutators); the
 * round-trips are bounded by tree depth, which is small in practice.
 */

import { z } from 'zod'
import {
  ChangeScope,
  CORE_BLOCK_DELETED_EVENT,
  defineMutator,
  type AnyMutator,
  type BlockData,
  type BlockReference,
  type PropertySchema,
  type Tx,
} from '@/data/api'
import { BlockNotFoundError } from '@/data/api'
import {
  keyAfterIndex,
  keyAtEnd,
  keyAtStart,
  keyBeforeIndex,
  keyBetween,
  keysAfterIndex,
  keysBeforeIndex,
  keysBetween,
} from './orderKey'
import { isCollapsedProp } from '@/data/properties'
import {
  mergeBlocksInTx,
  type ContentStrategy,
} from './blockMerge'

// ──── Common helpers ────

/** Read a block; throws BlockNotFoundError. Used by mutators that need
 *  more than the bare id (workspace lookup, sibling lookup, etc). */
const requireBlock = async (tx: Tx, id: string) => {
  const data = await tx.get(id)
  if (data === null) throw new BlockNotFoundError(id)
  return data
}

// `createSiblingAbove` / `createSiblingBelow` funnel through `orderKeyForInsert`
// (rather than computing against `tx.adjacentSibling`) so the tie-safe
// gap logic lives in exactly one place. The adjacent-sibling query resolves a
// tied neighbour by the `(order_key, id)` tiebreak — i.e. it returns a row with
// the SAME order_key — which would feed `keyBetween(equal, equal)` and throw
// (A1). The list-based helper instead widens to the next distinct key.
const orderKeyAfterSibling = (tx: Tx, sibling: BlockData): Promise<string> =>
  orderKeyForInsert(tx, sibling.parentId, sibling.workspaceId, {
    kind: 'after',
    siblingId: sibling.id,
  })

const orderKeyBeforeSibling = (tx: Tx, sibling: BlockData): Promise<string> =>
  orderKeyForInsert(tx, sibling.parentId, sibling.workspaceId, {
    kind: 'before',
    siblingId: sibling.id,
  })

/** Placement of a block within a parent's child list — an explicit
 *  position used by the insert/move mutators. */
type InsertPosition =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'after'; siblingId: string }
  | { kind: 'before'; siblingId: string }

/** Compute the order_key for inserting under `parentId` at a given
 *  `position`. Reads sibling list from SQL (tx.childrenOf is sorted by
 *  (order_key, id) per §11.4). `parentId === null` enumerates
 *  workspace-root siblings; the caller passes `workspaceId` explicitly
 *  so the lookup is scoped correctly even before the tx has pinned a
 *  workspace via a write (kernel mutators read the sibling/parent row
 *  first and have the workspace in hand at that point). */
const orderKeyForInsert = async (
  tx: Tx,
  parentId: string | null,
  workspaceId: string,
  position: InsertPosition,
): Promise<string> => {
  const siblings = await tx.childrenOf(parentId, workspaceId)

  if (position.kind === 'first') {
    return keyAtStart(siblings[0]?.orderKey ?? null)
  }
  if (position.kind === 'last') {
    return keyAtEnd(siblings.at(-1)?.orderKey ?? null)
  }
  // after / before — locate sibling and its neighbor
  const ix = siblings.findIndex(s => s.id === position.siblingId)
  if (ix < 0) {
    throw new Error(
      `position.${position.kind === 'after' ? 'after' : 'before'} sibling ${position.siblingId} not found under ${parentId ?? 'root'}`,
    )
  }
  // Tie-safe: when the anchor sibling shares an order_key with the neighbour on
  // the insertion side, `keyAfterIndex`/`keyBeforeIndex` widen to the next
  // DISTINCT key past the tied run (A1), so the new block lands just outside the
  // run on the requested side with a strictly-ordered key.
  const keys = siblings.map(s => s.orderKey)
  return position.kind === 'after'
    ? keyAfterIndex(keys, ix)
    : keyBeforeIndex(keys, ix)
}

const positionSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('first')}),
  z.object({kind: z.literal('last')}),
  z.object({kind: z.literal('after'), siblingId: z.string()}),
  z.object({kind: z.literal('before'), siblingId: z.string()}),
])

/** Re-home `block` under `parentId` at `position`, computing the order
 *  key. The shared core of `core.move` (explicit placement) and
 *  `moveVertical` (which computes a target then places the block) — both
 *  funnel their final write through here. */
const relocateBlock = async (
  tx: Tx,
  block: BlockData,
  parentId: string | null,
  position: InsertPosition,
): Promise<void> => {
  const orderKey = await orderKeyForInsert(tx, parentId, block.workspaceId, position)
  await tx.move(block.id, {parentId, orderKey})
}

/** Reveal a block's children by clearing a collapsed flag. Structural
 *  placements that put a block *as a child of* `id` call this so the
 *  inserted/moved block can't land inside a closed subtree and vanish.
 *  The shared invariant behind indent (reparent under previous sibling),
 *  moveVertical (descend into a neighbour), child-first create-below
 *  (vim `o` / Enter on a collapsed scope root), and paste-as-child.
 *  No-op when not collapsed. */
export const revealChildren = async (tx: Tx, id: string): Promise<void> => {
  if (await tx.getProperty(id, isCollapsedProp)) {
    await tx.setProperty(id, isCollapsedProp, false)
  }
}

// ──── setContent ────

export const setContent = defineMutator<{id: string; content: string}, void>({
  name: 'core.setContent',
  argsSchema: z.object({id: z.string(), content: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `set content on ${id}`,
  apply: async (tx, {id, content}) => {
    await tx.update(id, {content})
  },
})

// ──── setProperty (typed; codec applied by tx.setProperty) ────

/** Args for the kernel setProperty mutator. The `schema` field is a
 *  PropertySchema reference — TypeScript provides safety at call sites;
 *  runtime validation is permissive because PropertySchema instances
 *  carry codec functions and aren't structurally validatable. Dynamic
 *  plugins typically wrap this with their own typed mutator (per §12.1
 *  example). */
const setPropertySchema = z.object({
  id: z.string(),
  schema: z.unknown(),
  value: z.unknown(),
})

export const setProperty = defineMutator<
  {id: string; schema: PropertySchema<unknown>; value: unknown},
  void
>({
  name: 'core.setProperty',
  argsSchema: setPropertySchema as unknown as { parse: (x: unknown) => {id: string; schema: PropertySchema<unknown>; value: unknown} },
  // Scope is derived from the property's own `changeScope` so UI-state
  // schemas land in the UiState undo bucket, UserPrefs schemas in their
  // own, and content schemas keep the BlockDefault behavior. All scopes
  // upload uniformly; the scope identity is about undo segregation and
  // schema validation, not upload routing. Without this, every property
  // write would be tagged as a content edit regardless of how it was
  // declared.
  scope: ({schema}) => schema.changeScope,
  describe: ({id, schema}) => `set property ${schema.name} on ${id}`,
  apply: async (tx, {id, schema, value}) => {
    await tx.setProperty(id, schema, value)
  },
})

// ──── delete (subtree-aware soft-delete) ────

/** DFS walk via tx.childrenOf, calling tx.delete on each visited block.
 *  Iterative + explicit stack to avoid blowing the JS recursion limit
 *  on deep trees.
 *
 *  Each freshly soft-deleted block emits `CORE_BLOCK_DELETED_EVENT` so
 *  same-tx consumers can react atomically with the delete — the
 *  references plugin uses it to inline a deleted block's content into the
 *  blocks that referenced it (`((id))`), keeping those referrers readable
 *  instead of leaving dangling block-refs. We carry the `BlockData` from
 *  `childrenOf` (and one `tx.get` for the root) so the walk doesn't pay an
 *  extra per-node read just to recover `workspaceId`; the `!deleted` guard
 *  only ever skips an already-tombstoned root (children come back live). */
const softDeleteSubtree = async (tx: Tx, rootId: string): Promise<void> => {
  const root = await tx.get(rootId)
  // Preserve the primitive's contract for a missing root: let tx.delete
  // surface BlockNotFoundError rather than silently no-op here.
  if (root === null) {
    await tx.delete(rootId)
    return
  }
  const stack: BlockData[] = [root]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const block = stack.pop()!
    if (seen.has(block.id)) continue
    seen.add(block.id)
    const children = await tx.childrenOf(block.id)
    for (const c of children) stack.push(c)
    await tx.delete(block.id)
    if (!block.deleted) {
      tx.emitEvent(CORE_BLOCK_DELETED_EVENT, {
        workspaceId: block.workspaceId,
        blockId: block.id,
      })
    }
  }
}

export const deleteBlock = defineMutator<{id: string}, void>({
  name: 'core.delete',
  argsSchema: z.object({id: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `delete ${id} (subtree)`,
  apply: async (tx, {id}) => {
    await softDeleteSubtree(tx, id)
  },
})

// ──── createChild ────

interface CreateChildArgs {
  parentId: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
  /** Where to insert under the parent. Default 'last'. */
  position?:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string }
  /** Optional explicit id (deterministic-id callers). Engine assigns
   *  a UUID when absent. */
  id?: string
  /** Reveal the parent if it's collapsed, so the new child is visible.
   *  User-initiated "create child and focus it" paths (vim `o`, Enter
   *  on a collapsed scope root) set this; programmatic child creation
   *  leaves it off to avoid force-expanding. */
  revealParent?: boolean
}

const createChildSchema = z.object({
  parentId: z.string(),
  content: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  references: z.array(z.object({id: z.string(), alias: z.string()})).optional(),
  position: positionSchema.optional(),
  id: z.string().optional(),
  revealParent: z.boolean().optional(),
})

export const createChild = defineMutator<CreateChildArgs, string>({
  name: 'core.createChild',
  argsSchema: createChildSchema,
  resultSchema: z.string(),
  scope: ChangeScope.BlockDefault,
  describe: ({parentId}) => `create child under ${parentId}`,
  apply: async (tx, args) => {
    const parent = await requireBlock(tx, args.parentId)
    const orderKey = await orderKeyForInsert(tx, args.parentId, parent.workspaceId, args.position ?? {kind: 'last'})
    if (args.revealParent) await revealChildren(tx, args.parentId)
    return tx.create({
      id: args.id,
      workspaceId: parent.workspaceId,
      parentId: args.parentId,
      orderKey,
      content: args.content ?? '',
      properties: args.properties,
      references: args.references,
    })
  },
})

// ──── createSiblingAbove / createSiblingBelow ────

const siblingArgsSchema = z.object({
  siblingId: z.string(),
  content: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  references: z.array(z.object({id: z.string(), alias: z.string()})).optional(),
  id: z.string().optional(),
})

interface SiblingArgs {
  siblingId: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
  id?: string
}

export const createSiblingAbove = defineMutator<SiblingArgs, string>({
  name: 'core.createSiblingAbove',
  argsSchema: siblingArgsSchema,
  resultSchema: z.string(),
  scope: ChangeScope.BlockDefault,
  describe: ({siblingId}) => `create sibling above ${siblingId}`,
  apply: async (tx, args) => {
    const sibling = await requireBlock(tx, args.siblingId)
    const orderKey = await orderKeyBeforeSibling(tx, sibling)
    return tx.create({
      id: args.id,
      workspaceId: sibling.workspaceId,
      parentId: sibling.parentId,
      orderKey,
      content: args.content ?? '',
      properties: args.properties,
      references: args.references,
    })
  },
})

export const createSiblingBelow = defineMutator<SiblingArgs, string>({
  name: 'core.createSiblingBelow',
  argsSchema: siblingArgsSchema,
  resultSchema: z.string(),
  scope: ChangeScope.BlockDefault,
  describe: ({siblingId}) => `create sibling below ${siblingId}`,
  apply: async (tx, args) => {
    const sibling = await requireBlock(tx, args.siblingId)
    const orderKey = await orderKeyAfterSibling(tx, sibling)
    return tx.create({
      id: args.id,
      workspaceId: sibling.workspaceId,
      parentId: sibling.parentId,
      orderKey,
      content: args.content ?? '',
      properties: args.properties,
      references: args.references,
    })
  },
})

// ──── insertChildren ────

interface InsertChildrenArgs {
  parentId: string
  items: Array<{
    id?: string
    content?: string
    properties?: Record<string, unknown>
    references?: BlockReference[]
  }>
  /** Where to insert the run under the parent. Default 'last'. */
  position?:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string }
}

const insertChildrenSchema = z.object({
  parentId: z.string(),
  items: z.array(z.object({
    id: z.string().optional(),
    content: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    references: z.array(z.object({id: z.string(), alias: z.string()})).optional(),
  })),
  position: positionSchema.optional(),
})

export const insertChildren = defineMutator<InsertChildrenArgs, string[]>({
  name: 'core.insertChildren',
  argsSchema: insertChildrenSchema,
  resultSchema: z.array(z.string()),
  scope: ChangeScope.BlockDefault,
  describe: ({parentId, items}) => `insert ${items.length} children under ${parentId}`,
  apply: async (tx, args) => {
    if (args.items.length === 0) return []
    const parent = await requireBlock(tx, args.parentId)
    const siblings = await tx.childrenOf(args.parentId)
    const position = args.position ?? {kind: 'last'}

    const n = args.items.length
    const keys = ((): string[] => {
      if (position.kind === 'first') return keysBetween(null, siblings[0]?.orderKey ?? null, n)
      if (position.kind === 'last')  return keysBetween(siblings.at(-1)?.orderKey ?? null, null, n)
      const ix = siblings.findIndex(s => s.id === position.siblingId)
      if (ix < 0) throw new Error(`sibling ${position.siblingId} not found under ${args.parentId}`)
      // Tie-safe (A1): widen past a tied run to the next distinct key on the
      // requested side, so the whole run inserts just outside the tie.
      const orderKeys = siblings.map(s => s.orderKey)
      return position.kind === 'after'
        ? keysAfterIndex(orderKeys, ix, n)
        : keysBeforeIndex(orderKeys, ix, n)
    })()
    const ids: string[] = []
    for (let i = 0; i < args.items.length; i++) {
      const item = args.items[i]
      const id = await tx.create({
        id: item.id,
        workspaceId: parent.workspaceId,
        parentId: args.parentId,
        orderKey: keys[i],
        content: item.content ?? '',
        properties: item.properties,
        references: item.references,
      })
      ids.push(id)
    }
    return ids
  },
})

// ──── move (explicit) ────

interface MoveArgs {
  id: string
  parentId: string | null
  position:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string }
}

const moveSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  position: positionSchema,
})

export const move = defineMutator<MoveArgs, void>({
  name: 'core.move',
  argsSchema: moveSchema,
  scope: ChangeScope.BlockDefault,
  describe: ({id, parentId}) => `move ${id} → ${parentId ?? 'root'}`,
  apply: async (tx, args) => {
    // Read the moving block first so we know which workspace's root
    // siblings to enumerate when args.parentId is null. The block's
    // workspace_id is immutable (server-side trigger enforces it), so
    // it's also the destination workspace.
    const self = await requireBlock(tx, args.id)
    await relocateBlock(tx, self, args.parentId, args.position)
  },
})

// ──── setOrderKey (direct) ────

export const setOrderKey = defineMutator<{id: string; orderKey: string}, void>({
  name: 'core.setOrderKey',
  argsSchema: z.object({id: z.string(), orderKey: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `setOrderKey ${id}`,
  apply: async (tx, {id, orderKey}) => {
    const before = await requireBlock(tx, id)
    await tx.move(id, {parentId: before.parentId, orderKey})
  },
})

// ──── indent ────

export const indent = defineMutator<{id: string}, void>({
  name: 'core.indent',
  argsSchema: z.object({id: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `indent ${id}`,
  apply: async (tx, {id}) => {
    const self = await requireBlock(tx, id)
    if (self.parentId === null) {
      // No parent — can't indent the root. Legacy was a no-op here.
      return
    }
    const siblings = await tx.childrenOf(self.parentId)
    const ix = siblings.findIndex(s => s.id === id)
    if (ix <= 0) return  // no previous sibling — no-op
    const newParent = siblings[ix - 1]
    const newParentChildren = await tx.childrenOf(newParent.id)
    const orderKey = keyAtEnd(newParentChildren.at(-1)?.orderKey ?? null)
    await tx.move(id, {parentId: newParent.id, orderKey})
    await revealChildren(tx, newParent.id)
  },
})

// ──── outdent ────

interface OutdentArgs {
  id: string
  /** Optional surface boundary — the root of the visible subtree the
   *  caller renders (the panel's zoom root on the main outline, a
   *  backlink entry's shown block, …). If `self.parentId === scopeRootId`,
   *  outdent is a no-op — the block is a direct child of the surface's
   *  root and outdenting would move it outside the visible scope (or to
   *  the workspace root for root-level views). Returns `false` in that
   *  case so callers can fall back. */
  scopeRootId?: string
}

export const outdent = defineMutator<OutdentArgs, boolean>({
  name: 'core.outdent',
  argsSchema: z.object({
    id: z.string(),
    scopeRootId: z.string().optional(),
  }),
  resultSchema: z.boolean(),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `outdent ${id}`,
  apply: async (tx, {id, scopeRootId}) => {
    const self = await requireBlock(tx, id)
    if (self.parentId === null) return false  // already at root
    // Refuse to outdent past the surface boundary — a direct child of
    // `scopeRootId` would otherwise pop out to the grandparent (or
    // workspace root), exiting the visible scope.
    if (scopeRootId !== undefined && self.parentId === scopeRootId) return false
    const parent = await requireBlock(tx, self.parentId)
    // Move under grandparent, positioned right after current parent.
    // tx.childrenOf(null) enumerates root-level siblings of the pinned
    // workspace, so the same logic works for both nested and root
    // outdents — no root-level approximation needed.
    const grandparent = parent.parentId
    // Pass self.workspaceId so the null-grandparent case scopes
    // correctly even before this tx pins a workspace.
    const grandSiblings = await tx.childrenOf(grandparent, self.workspaceId)
    const parentIx = grandSiblings.findIndex(s => s.id === parent.id)
    let orderKey: string
    if (parentIx < 0) {
      // Stale read — fall back to last position under grandparent.
      orderKey = keyAtEnd(grandSiblings.at(-1)?.orderKey ?? null)
    } else {
      // Tie-safe (A1): if the parent shares an order_key with its next
      // grand-sibling, widen past the tied run so the outdented block still
      // lands just after the parent with a strictly-ordered key.
      orderKey = keyAfterIndex(grandSiblings.map(s => s.orderKey), parentIx)
    }
    await tx.move(id, {parentId: grandparent, orderKey})
    return true
  },
})

// ──── moveVertical ────

interface MoveVerticalArgs {
  id: string
  /** -1 = up (toward the top of the visible list), +1 = down. */
  direction: -1 | 1
  /** Surface boundary — the root of the visible subtree (see the
   *  `outdent` mutator and `BlockContextType.scopeRootId`). The block
   *  never moves above/below this root, and a direct child of it won't
   *  cross out of the scope. */
  scopeRootId?: string
}

/**
 * Move a block one step up or down in the visible outline, WITHOUT ever
 * changing its indentation. Within a sibling list it swaps with the
 * adjacent sibling; when it is the first/last child of its parent it
 * moves into the neighbouring sibling subtree at the SAME depth it
 * already had:
 *
 *     a            a
 *       b            b
 *         c            c
 *     d     ──▶      e   (move e up → a's last child; e stays depth 1)
 *       e          d
 *
 * Rules (up; down mirrors):
 *  - has a previous sibling          → swap before it (same parent);
 *  - first child, parent has a
 *    previous sibling Q              → become Q's last child — same depth
 *                                      the block already had. Q is
 *                                      revealed if collapsed, mirroring
 *                                      how `indent` reveals a collapsed
 *                                      new parent;
 *  - first child, parent is itself   → no-op. The only one-step-up slot
 *    the first child                   would be a shallower level, and
 *                                      moveVertical never outdents.
 *
 * Indentation is invariant: every move keeps the block at its original
 * depth, so it never pops out to / into a shallower or deeper level.
 * Bounded by `scopeRootId`: the scope root never moves, and a first/last
 * direct child of it won't cross out. Returns whether anything moved so
 * callers can no-op cleanly.
 */
export const moveVertical = defineMutator<MoveVerticalArgs, boolean>({
  name: 'core.moveVertical',
  argsSchema: z.object({
    id: z.string(),
    direction: z.union([z.literal(-1), z.literal(1)]),
    scopeRootId: z.string().optional(),
  }),
  resultSchema: z.boolean(),
  scope: ChangeScope.BlockDefault,
  describe: ({id, direction}) => `move ${id} ${direction === -1 ? 'up' : 'down'}`,
  apply: async (tx, {id, direction, scopeRootId}) => {
    const self = await requireBlock(tx, id)
    if (self.parentId === null) return false
    // The scope root anchors the view; it can't move within itself.
    if (scopeRootId !== undefined && id === scopeRootId) return false

    const siblings = await tx.childrenOf(self.parentId)
    const idx = siblings.findIndex(s => s.id === id)
    if (idx === -1) return false

    const target = await ((): Promise<{parentId: string | null; position: InsertPosition} | null> => {
      const up = direction === -1
      const hasAdjacentSibling = up ? idx > 0 : idx < siblings.length - 1
      if (hasAdjacentSibling) {
        const adjacent = siblings[up ? idx - 1 : idx + 1]
        return Promise.resolve({
          parentId: self.parentId,
          position: up
            ? {kind: 'before', siblingId: adjacent.id}
            : {kind: 'after', siblingId: adjacent.id},
        })
      }
      // Edge of the sibling list — move into the neighbouring sibling
      // subtree at the same depth. If the parent has no neighbouring
      // sibling (it's itself the first/last child), the only one-step
      // slot would be a shallower level, which would change indentation,
      // so it's a no-op.
      return (async () => {
        // Cross-parent moves are bounded by the visible surface, so they
        // need a scope root. Without one (e.g. a bridge run-action with no
        // UI context) keep the move same-parent only — the edge is a
        // no-op, matching the previous reorder behaviour — rather than
        // reparenting into an unbounded neighbour/page.
        if (scopeRootId === undefined || self.parentId === scopeRootId) return null
        const parent = await requireBlock(tx, self.parentId!)
        const parentSiblings = await tx.childrenOf(parent.parentId, self.workspaceId)
        const pIdx = parentSiblings.findIndex(s => s.id === parent.id)
        const neighbourParent = up ? parentSiblings[pIdx - 1] : parentSiblings[pIdx + 1]
        if (!neighbourParent) return null
        return {
          parentId: neighbourParent.id,
          position: up ? {kind: 'last' as const} : {kind: 'first' as const},
        }
      })()
    })()

    if (!target) return false
    // Moving INTO a neighbouring subtree (target parent ≠ current parent)
    // reveals it if collapsed, so the block stays visible.
    if (target.parentId !== null && target.parentId !== self.parentId) {
      await revealChildren(tx, target.parentId)
    }
    await relocateBlock(tx, self, target.parentId, target.position)
    return true
  },
})

// ──── split ────

interface SplitArgs {
  id: string
  /** Content for the new sibling-before (the prefix). */
  before: string
  /** New content for the original block (the suffix). */
  after: string
}

export const split = defineMutator<SplitArgs, string>({
  name: 'core.split',
  argsSchema: z.object({
    id: z.string(),
    before: z.string(),
    after: z.string(),
  }),
  resultSchema: z.string(),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `split ${id}`,
  // Callers pass the live `before`/`after` strings (e.g. from CodeMirror's
  // current doc, sliced at the cursor). The mutator does NOT slice
  // self.content — debounced editors can leave SQL stale, and slicing
  // there would split the wrong text and lose the live edits. See
  // §13.3 / phase-1 review feedback.
  apply: async (tx, {id, before, after}) => {
    const self = await requireBlock(tx, id)
    await tx.update(id, {content: after})
    // Compute order_key for the new prefix sibling — between self and
    // its previous sibling. Pass self.workspaceId for the null-parent
    // case so the root-sibling lookup is workspace-scoped (the
    // pinned-meta would also work here since tx.update above already
    // pinned, but the explicit pass is clearer and less brittle).
    const siblings = await tx.childrenOf(self.parentId, self.workspaceId)
    const ix = siblings.findIndex(s => s.id === id)
    const prev = ix >= 0 ? siblings[ix - 1] : undefined

    // The prefix sibling must sort IMMEDIATELY before `self` — that's the one
    // case (A1) "widen to the next distinct neighbour" can't satisfy: if `self`
    // ties with its immediate predecessor there is no key strictly between
    // them, and `keyBetween(prevKey, selfKey)` throws (rolling back and losing
    // the typed split). Re-key `self` out of the tie first — bump it to a fresh
    // key strictly above its tied run and below the next distinct sibling — so a
    // strict gap exists for the prefix. `self` keeps its relative position (it
    // was already the highest-id, hence last, member of that tied run on its
    // side), so nothing visibly reorders.
    let selfKey = self.orderKey
    if (prev !== undefined && prev.orderKey === self.orderKey) {
      // `prev` defined ⇒ ix >= 1, so `ix - 1` (prev's index) is in range.
      const keys = siblings.map(s => s.orderKey)
      selfKey = keyAfterIndex(keys, ix - 1)  // strictly above the tied run, below next distinct
      await tx.move(id, {parentId: self.parentId, orderKey: selfKey})
    }
    const orderKey = keyBetween(prev?.orderKey ?? null, selfKey)
    return tx.create({
      workspaceId: self.workspaceId,
      parentId: self.parentId,
      orderKey,
      content: before,
    })
  },
})

// ──── merge ────

export type { ContentStrategy } from './blockMerge'

const contentStrategySchema = z.union([
  z.literal('concat'),
  z.literal('keepTarget'),
  z.object({separator: z.string()}),
])

interface MergeArgs {
  /** The block that absorbs the other's content + properties + children. */
  intoId: string
  /** The block whose data folds into the target, then soft-deleted. */
  fromId: string
  /** How to combine content. Defaults to `'concat'` for back-compat. */
  contentStrategy?: ContentStrategy
}

export const merge = defineMutator<MergeArgs, void>({
  name: 'core.merge',
  argsSchema: z.object({
    intoId: z.string(),
    fromId: z.string(),
    contentStrategy: contentStrategySchema.optional(),
  }),
  scope: ChangeScope.BlockDefault,
  describe: ({intoId, fromId}) => `merge ${fromId} → ${intoId}`,
  apply: async (tx, {intoId, fromId, contentStrategy = 'concat'}) => {
    const into = await requireBlock(tx, intoId)
    const from = await requireBlock(tx, fromId)
    await mergeBlocksInTx(tx, {into, from, contentStrategy})
  },
})

// ──── Bundle ────

/** All kernel mutators in one array — registered with `Repo` by
 *  `repo.setFacetRuntime` (or the bootstrapping helper that supplies
 *  the facet runtime). Typed as `AnyMutator[]` because the mutators
 *  have heterogeneous `Args`/`Result` shapes; precise types stay at
 *  the per-mutator definition sites and reach callers through the
 *  `MutatorRegistry` augmentation. */
export const KERNEL_MUTATORS: ReadonlyArray<AnyMutator> = [
  setContent,
  setProperty,
  deleteBlock,
  createChild,
  createSiblingAbove,
  createSiblingBelow,
  insertChildren,
  move,
  setOrderKey,
  indent,
  outdent,
  moveVertical,
  split,
  merge,
]

// ──── Type registry augmentation ────

/** Register every kernel mutator with `MutatorRegistry` so call sites
 *  using `repo.mutate.<name>(args)` and `repo.mutate['core.<name>'](args)`
 *  get precise arg + result types without `as` casts. Plugins extend the
 *  same interface from their own module per §12.1. */
declare module '@/data/api' {
  interface MutatorRegistry {
    'core.setContent': typeof setContent
    'core.setProperty': typeof setProperty
    'core.delete': typeof deleteBlock
    'core.createChild': typeof createChild
    'core.createSiblingAbove': typeof createSiblingAbove
    'core.createSiblingBelow': typeof createSiblingBelow
    'core.insertChildren': typeof insertChildren
    'core.move': typeof move
    'core.setOrderKey': typeof setOrderKey
    'core.indent': typeof indent
    'core.outdent': typeof outdent
    'core.moveVertical': typeof moveVertical
    'core.split': typeof split
    'core.merge': typeof merge
  }
}
