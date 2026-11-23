import type { BlockData } from '@/data/api'
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

/** The children a surface draws under one parent, in drawn order. A layout
 *  that draws a block's children its own way declares the same list here, so
 *  every gesture that walks "as drawn" (the outline walkers, the edit policy,
 *  Backspace-merge) walks what that layout draws.
 *
 *  The list holds the parent's own children, any subset in any order: the
 *  walkers climb by a block's data parent, so a block listed under a parent it
 *  is not a child of would be stepped into and never back out of. */
export interface ChildrenView {
  id: string
  read(ctx: ChildrenViewContext): LoaderHandle<string[]>
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
