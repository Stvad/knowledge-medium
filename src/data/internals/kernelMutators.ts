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
  type BlockReference,
  type Mutator,
  type PropertySchema,
  type Tx,
} from '@/data/api'
import { BlockNotFoundError, ParentDeletedError } from '@/data/api'
import { keyAtEnd, keyAtStart, keyBetween, keysBetween } from './orderKey'

// ──── Common helpers ────

/** Read a block; throws BlockNotFoundError. Used by mutators that need
 *  more than the bare id (workspace lookup, sibling lookup, etc). */
const requireBlock = async (tx: Tx, id: string) => {
  const data = await tx.get(id)
  if (data === null) throw new BlockNotFoundError(id)
  return data
}

/** Compute the order_key for inserting under `parentId` at a given
 *  `position`. Reads sibling list from SQL (tx.childrenOf is sorted by
 *  (order_key, id) per §11.4). */
const orderKeyForInsert = async (
  tx: Tx,
  parentId: string | null,
  position:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string },
): Promise<string> => {
  const siblings = parentId === null ? [] : await tx.childrenOf(parentId)

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

/** Refuse to create or move under a soft-deleted parent — UX rule per
 *  §4.7 Layer 1 (v4.30). Storage layer accepts soft-deleted parents;
 *  the kernel mutator layer is where the friendly error lives. */
const requireLiveParent = async (tx: Tx, parentId: string | null): Promise<void> => {
  if (parentId === null) return
  const parent = await tx.get(parentId)
  if (parent === null) {
    // Parent existence will surface from the storage layer as a
    // translated error — let it through. (Alternative: throw a kernel
    // ParentNotFoundError here; deferred until we observe a need.)
    return
  }
  if (parent.deleted) throw new ParentDeletedError(parentId)
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
  scope: ChangeScope.BlockDefault,
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
    if (parent.deleted) throw new ParentDeletedError(args.parentId)
    const orderKey = await orderKeyForInsert(tx, args.parentId, args.position ?? {kind: 'last'})
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
    await requireLiveParent(tx, sibling.parentId)
    const orderKey = await orderKeyForInsert(tx, sibling.parentId, {
      kind: 'before',
      siblingId: args.siblingId,
    })
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
    await requireLiveParent(tx, sibling.parentId)
    const orderKey = await orderKeyForInsert(tx, sibling.parentId, {
      kind: 'after',
      siblingId: args.siblingId,
    })
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
    if (parent.deleted) throw new ParentDeletedError(args.parentId)
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
    await requireLiveParent(tx, args.parentId)
    const orderKey = await orderKeyForInsert(tx, args.parentId, args.position)
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
    if (newParent.deleted) throw new ParentDeletedError(newParent.id)
    const newParentChildren = await tx.childrenOf(newParent.id)
    const orderKey = keyAtEnd(newParentChildren.at(-1)?.orderKey ?? null)
    await tx.move(id, {parentId: newParent.id, orderKey})
  },
})

// ──── outdent ────

export const outdent = defineMutator<{id: string}, void>({
  name: 'core.outdent',
  argsSchema: z.object({id: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `outdent ${id}`,
  apply: async (tx, {id}) => {
    const self = await requireBlock(tx, id)
    if (self.parentId === null) return  // already at root
    const parent = await requireBlock(tx, self.parentId)
    // Move under grandparent, positioned right after current parent.
    const grandparent = parent.parentId
    await requireLiveParent(tx, grandparent)
    const grandSiblings = grandparent === null
      ? []  // root level — null parentId means we sit at workspace root with no orderKey constraints from a "parent's children" list; positioning is by order_key alone
      : await tx.childrenOf(grandparent)
    let orderKey: string
    if (grandparent === null) {
      // Root level: no childrenOf available (parentId is null). The
      // outdented row goes immediately after `parent`. We need parent's
      // own orderKey and the next root's orderKey. Read root rows via
      // tx.childrenOf is not callable for null; fall back to a direct
      // sibling computation: position after parent at the workspace
      // root requires knowing the next root sibling. Without a
      // childrenOf(null) primitive we approximate by using
      // parent.orderKey as lower bound and null as upper. That places
      // the outdented child after the parent and after any other root
      // rows whose order_key happens to fall between — acceptable for
      // the common case (single-page roots) and matches legacy outdent
      // behavior of "land at end of root level."
      orderKey = keyAtEnd(parent.orderKey)
    } else {
      const parentIx = grandSiblings.findIndex(s => s.id === parent.id)
      if (parentIx < 0) {
        // Stale read — fall back to last position under grandparent.
        orderKey = keyAtEnd(grandSiblings.at(-1)?.orderKey ?? null)
      } else {
        const next = grandSiblings[parentIx + 1]
        orderKey = keyBetween(parent.orderKey, next?.orderKey ?? null)
      }
    }
    await tx.move(id, {parentId: grandparent, orderKey})
  },
})

// ──── split ────

interface SplitArgs {
  id: string
  /** Character offset within the block's content. The original block
   *  retains content[0..at]; a new sibling-after gets content[at..]. */
  at: number
}

export const split = defineMutator<SplitArgs, string>({
  name: 'core.split',
  argsSchema: z.object({id: z.string(), at: z.number().int().nonnegative()}),
  resultSchema: z.string(),
  scope: ChangeScope.BlockDefault,
  describe: ({id, at}) => `split ${id} @ ${at}`,
  apply: async (tx, {id, at}) => {
    const self = await requireBlock(tx, id)
    const prefix = self.content.slice(0, at)
    const suffix = self.content.slice(at)
    await tx.update(id, {content: prefix})
    // Compute order_key for the new sibling — between self and its next sibling.
    let orderKey: string
    if (self.parentId === null) {
      // Root level — no childrenOf(null). Same approximation as outdent.
      orderKey = keyAtEnd(self.orderKey)
    } else {
      const siblings = await tx.childrenOf(self.parentId)
      const ix = siblings.findIndex(s => s.id === id)
      const next = ix >= 0 ? siblings[ix + 1] : undefined
      orderKey = keyBetween(self.orderKey, next?.orderKey ?? null)
    }
    return tx.create({
      workspaceId: self.workspaceId,
      parentId: self.parentId,
      orderKey,
      content: suffix,
    })
  },
})

// ──── merge ────

interface MergeArgs {
  /** The block that absorbs the other's content + children. */
  intoId: string
  /** The block whose content + children get folded in, then soft-deleted. */
  fromId: string
}

export const merge = defineMutator<MergeArgs, void>({
  name: 'core.merge',
  argsSchema: z.object({intoId: z.string(), fromId: z.string()}),
  scope: ChangeScope.BlockDefault,
  describe: ({intoId, fromId}) => `merge ${fromId} → ${intoId}`,
  apply: async (tx, {intoId, fromId}) => {
    const into = await requireBlock(tx, intoId)
    const from = await requireBlock(tx, fromId)
    await tx.update(intoId, {content: into.content + from.content})
    // Re-parent `from`'s direct children under `into` at the end of
    // its current children list. (Their own descendants come along
    // naturally — parent_id chains stay intact under SQLite's
    // single-row updates.)
    const intoChildren = await tx.childrenOf(intoId)
    const fromChildren = await tx.childrenOf(fromId)
    if (fromChildren.length > 0) {
      const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length)
      for (let i = 0; i < fromChildren.length; i++) {
        await tx.move(fromChildren[i].id, {parentId: intoId, orderKey: keys[i]})
      }
    }
    await tx.delete(fromId)
  },
})

// ──── Bundle ────

/** All kernel mutators in one array — registered with `Repo` by
 *  `repo.setFacetRuntime` (or the bootstrapping helper that supplies
 *  the facet runtime). */
export const KERNEL_MUTATORS: ReadonlyArray<Mutator<unknown, unknown>> = [
  setContent as Mutator,
  setProperty as Mutator,
  deleteBlock as Mutator,
  createChild as Mutator,
  createSiblingAbove as Mutator,
  createSiblingBelow as Mutator,
  insertChildren as Mutator,
  move as Mutator,
  setOrderKey as Mutator,
  indent as Mutator,
  outdent as Mutator,
  split as Mutator,
  merge as Mutator,
]
