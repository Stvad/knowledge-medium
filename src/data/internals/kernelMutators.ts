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
  defineMutator,
  type AnyMutator,
  type BlockData,
  type BlockReference,
  type PropertySchema,
  type Tx,
} from '@/data/api'
import { BlockNotFoundError } from '@/data/api'
import { keyAtEnd, keyAtStart, keyBetween, keysBetween } from '../orderKey'
import { mergeProperties } from './mergeProperties'
import { isCollapsedProp } from '@/data/properties'

// ──── Common helpers ────

/** Read a block; throws BlockNotFoundError. Used by mutators that need
 *  more than the bare id (workspace lookup, sibling lookup, etc). */
const requireBlock = async (tx: Tx, id: string) => {
  const data = await tx.get(id)
  if (data === null) throw new BlockNotFoundError(id)
  return data
}

const orderKeyAfterSibling = async (tx: Tx, sibling: BlockData): Promise<string> => {
  const next = await tx.adjacentSibling(sibling, 'after')
  return keyBetween(sibling.orderKey, next?.orderKey ?? null)
}

const orderKeyBeforeSibling = async (tx: Tx, sibling: BlockData): Promise<string> => {
  const previous = await tx.adjacentSibling(sibling, 'before')
  return keyBetween(previous?.orderKey ?? null, sibling.orderKey)
}

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
  position:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string },
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
  if (position.kind === 'after') {
    const next = siblings[ix + 1]
    return keyBetween(siblings[ix].orderKey, next?.orderKey ?? null)
  }
  // before
  const prev = siblings[ix - 1]
  return keyBetween(prev?.orderKey ?? null, siblings[ix].orderKey)
}

const positionSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('first')}),
  z.object({kind: z.literal('last')}),
  z.object({kind: z.literal('after'), siblingId: z.string()}),
  z.object({kind: z.literal('before'), siblingId: z.string()}),
])

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

/** DFS walk via tx.childrenOf, calling tx.delete on each visited id.
 *  Iterative + explicit stack to avoid blowing the JS recursion limit
 *  on deep trees. */
const softDeleteSubtree = async (tx: Tx, rootId: string): Promise<void> => {
  const stack: string[] = [rootId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const children = await tx.childrenOf(id)
    for (const c of children) stack.push(c.id)
    await tx.delete(id)
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
}

const createChildSchema = z.object({
  parentId: z.string(),
  content: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  references: z.array(z.object({id: z.string(), alias: z.string()})).optional(),
  position: positionSchema.optional(),
  id: z.string().optional(),
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

    const [lower, upper] = ((): [string | null, string | null] => {
      if (position.kind === 'first') return [null, siblings[0]?.orderKey ?? null]
      if (position.kind === 'last')  return [siblings.at(-1)?.orderKey ?? null, null]
      const ix = siblings.findIndex(s => s.id === position.siblingId)
      if (ix < 0) throw new Error(`sibling ${position.siblingId} not found under ${args.parentId}`)
      if (position.kind === 'after')  return [siblings[ix].orderKey, siblings[ix + 1]?.orderKey ?? null]
      return [siblings[ix - 1]?.orderKey ?? null, siblings[ix].orderKey]
    })()
    const keys = keysBetween(lower, upper, args.items.length)
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
    const orderKey = await orderKeyForInsert(tx, args.parentId, self.workspaceId, args.position)
    await tx.move(args.id, {parentId: args.parentId, orderKey})
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
    if (await tx.getProperty(newParent.id, isCollapsedProp)) {
      await tx.setProperty(newParent.id, isCollapsedProp, false)
    }
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
      const next = grandSiblings[parentIx + 1]
      orderKey = keyBetween(parent.orderKey, next?.orderKey ?? null)
    }
    await tx.move(id, {parentId: grandparent, orderKey})
    return true
  },
})

// ──── moveVertical ────

type InsertPosition =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'after'; siblingId: string }
  | { kind: 'before'; siblingId: string }

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
        if (self.parentId === scopeRootId) return null
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
    // reveals it if collapsed, so the block stays visible — same as
    // `indent` does when reparenting under a collapsed new parent.
    if (target.parentId !== null && target.parentId !== self.parentId) {
      if (await tx.getProperty(target.parentId, isCollapsedProp)) {
        await tx.setProperty(target.parentId, isCollapsedProp, false)
      }
    }
    const orderKey = await orderKeyForInsert(tx, target.parentId, self.workspaceId, target.position)
    await tx.move(id, {parentId: target.parentId, orderKey})
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
    const orderKey = keyBetween(prev?.orderKey ?? null, self.orderKey)
    return tx.create({
      workspaceId: self.workspaceId,
      parentId: self.parentId,
      orderKey,
      content: before,
    })
  },
})

// ──── merge ────

/** How target and source content are combined.
 *  - `'concat'`  → `into.content + from.content`. Default; matches the
 *    Backspace-at-block-start caller that needs zero-separator splice.
 *  - `'keepTarget'` → keep target content; fall back to source's only when
 *    target is empty (avoids silent loss in the canonical-stub-absorbs-
 *    real-page case). Used for type-aware page merges where two prose
 *    bodies don't compose meaningfully.
 *  - `{separator}` → join with an explicit string between the two.
 */
export type ContentStrategy = 'concat' | 'keepTarget' | { separator: string }

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

const computeMergedContent = (
  intoContent: string,
  fromContent: string,
  strategy: ContentStrategy,
): string => {
  if (strategy === 'concat') return intoContent + fromContent
  if (strategy === 'keepTarget') {
    return intoContent.length > 0 ? intoContent : fromContent
  }
  return intoContent + strategy.separator + fromContent
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

    // Re-parent `from`'s direct children under `into` at the end of
    // its current children list. Their own descendants come along
    // naturally — parent_id chains stay intact under SQLite's
    // single-row updates.
    const intoChildren = await tx.childrenOf(intoId)
    const fromChildren = await tx.childrenOf(fromId)
    if (fromChildren.length > 0) {
      const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length)
      for (let i = 0; i < fromChildren.length; i++) {
        await tx.move(fromChildren[i].id, {parentId: intoId, orderKey: keys[i]})
      }
    }

    // Soft-delete source BEFORE writing the merged property bag to the
    // target. The alias-uniqueness trigger on `block_aliases` is keyed
    // off live (non-deleted) rows; if source still holds an alias that
    // the merged bag adds to the target, the property write rejects.
    await tx.delete(fromId)

    await tx.update(intoId, {
      content: computeMergedContent(into.content, from.content, contentStrategy),
      properties: mergeProperties(into.properties, from.properties),
    })
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
