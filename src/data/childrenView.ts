import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { OutlineSurface } from '@/data/outlineSurface'
import type { Block } from '@/data/block'
import type { LoaderHandle } from '@/data/internals/handleStore'
import { childrenViewIn, displayScopeOf, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import { combineLastContributionResult, defineFacet, type OptionalContributionResult } from '@/facets/facet'

/** Where a child list is drawn: what a children view may key its answer on. */
export interface ListingSurface {
  readonly propertyDisplay: PropertyDisplayScopeLevels
  /** The render scope the parent is drawn in; absent for a dispatch with no mount. */
  readonly renderScopeId?: string
  /** Root of the visible subtree the parent is drawn within. */
  readonly scopeRootId?: string
}

/** What a gesture's dependencies say about where its lists are drawn. The one
 *  builder: a surface assembled by hand drops whichever field it forgets, and
 *  a view keyed on that field then silently falls back to the default. */
export const listingSurfaceOf = (carrier: Partial<ListingSurface>): ListingSurface => ({
  propertyDisplay: displayScopeOf(carrier),
  renderScopeId: carrier.renderScopeId,
  scopeRootId: carrier.scopeRootId,
})

export interface ChildrenViewContext {
  parent: Block
  /** `parent`'s row, loaded. */
  data: BlockData
  surface: ListingSurface
}

/** An ordered list drawn in another render scope. Omit members for an opaque
 *  surface. A block occurs at most once in a render scope. */
export interface NestedSurface {
  readonly kind: 'nested-surface'
  readonly renderScopeId: string
  readonly members?: readonly string[]
  /** Members sharing one editing root may merge with siblings inside it.
   *  Omit when each member is the structural root of its own subtree. */
  readonly scopeRootId?: string
  readonly propertyDisplay?: PropertyDisplayScopeLevels
  /** Members may belong to different pages. Each one's subtree bounds a range. */
  readonly foreign?: boolean
}

interface OwnerContext {
  repo: Repo
  renderScopeId: string
}

export interface SurfaceOwner {
  blockId: string
  surface: OutlineSurface
}

type OwnerContribution = (ctx: OwnerContext) => OptionalContributionResult<SurfaceOwner>

/** Reverse of a children's view declaration, used when a gesture starts in
 *  the nested scope. The owner supplies its own enclosing display and root. */
export const surfaceOwnerFacet = defineFacet<
  OwnerContribution,
  (ctx: OwnerContext) => SurfaceOwner | undefined
>({
  id: 'core.surface-owner',
  combine: combineLastContributionResult<OwnerContext, SurfaceOwner>(),
  empty: () => () => undefined,
  validate: (value): value is OwnerContribution => typeof value === 'function',
})

/** One thing drawn under a parent: a block in the parent's own render scope, or a nested surface. */
export type DrawnChild = string | NestedSurface

export const isNestedSurface = (child: DrawnChild): child is NestedSurface => typeof child !== 'string'

/** The children a surface draws under one parent, in drawn order. A layout
 *  that draws a block's children its own way declares the same list here, so
 *  every gesture that walks "as drawn" (the outline walkers, the edit policy,
 *  Backspace-merge) walks what that layout draws.
 *
 *  Strings name the parent's own children. A nested surface can list blocks
 *  from any parent, and declares its owner through surfaceOwnerFacet. */
export interface ChildrenView {
  id: string
  read(ctx: ChildrenViewContext): LoaderHandle<string[]> | LoaderHandle<DrawnChild[]>
}

export type ChildrenViewContribution = (ctx: ChildrenViewContext) => OptionalContributionResult<ChildrenView>

/** The last contribution with an answer wins, by precedence; none answering
 *  leaves the property-display default ({@link propertyDisplayChildrenView}).
 *  A view replaces the list outright: one that extends the default reads
 *  `propertyDisplayChildrenView` itself.
 *
 *  Read-side only: the structural mutators (indent, outdent, move, paste's
 *  placement) resolve their anchors on the property-display list inside the
 *  transaction (`visibleChildrenOf`). A view whose list differs from that one
 *  handles those verbs on its blocks itself. */
export const childrenViewFacet = defineFacet<
  ChildrenViewContribution,
  (ctx: ChildrenViewContext) => ChildrenView | undefined
>({
  id: 'core.children-view',
  combine: combineLastContributionResult<ChildrenViewContext, ChildrenView>(),
  empty: () => () => undefined,
  validate: (value): value is ChildrenViewContribution => typeof value === 'function',
})

/** The outline's own view: the parent's property display setting over the surface's. */
export const propertyDisplayChildrenView: ChildrenView = {
  id: 'core.property-display',
  read: ({parent, data, surface}) =>
    parent.repo.query.childIds({id: parent.id, propertyChildren: childrenViewIn(surface.propertyDisplay, data)}),
}

/** The view that decides what `ctx` draws. */
export const childrenViewFor = (ctx: ChildrenViewContext): ChildrenView =>
  ctx.parent.repo.facetRuntime?.read(childrenViewFacet)(ctx) ?? propertyDisplayChildrenView
