/**
 * Facet for plugins to override the *display* of a wikilink without
 * touching its underlying alias, link target, or storage. The first
 * decorator (by precedence order) to return a non-null value wins;
 * a null/undefined return falls through to the next decorator and
 * ultimately to the wikilink's default rendering (the alias text).
 *
 * Decorators receive the full link context so they can make
 * resolution-aware decisions — e.g. render differently when the alias
 * resolved to no block yet, or scope behavior per workspace.
 *
 * Used by daily-notes to prefix date references with the weekday
 * ("Fri, April 26th, 2026") at render time, while the stored alias
 * remains the canonical "April 26th, 2026" the link resolver depends on.
 */
import { isValidElement, type ReactNode } from 'react'
import type { Block } from '@/data/block'
import { defineFacet, type FacetRuntime } from '@/facets/facet.js'

export interface WikilinkDisplayContext {
  alias: string
  /** Resolved block id, or '' when the alias didn't match any block. */
  blockId: string
  /** Block whose markdown content contains this wikilink. */
  sourceBlock?: Block
  workspaceId: string
  /** Runtime available to display decorators that need to consult other facets. */
  runtime?: FacetRuntime
}

export interface WikilinkDisplayParts {
  /** Content rendered inside the normal wikilink anchor. */
  content: ReactNode
  /** Inline chrome rendered immediately before the anchor, outside the link. */
  before?: ReactNode
  /** Inline chrome rendered immediately after the anchor, outside the link. */
  after?: ReactNode
}

export type WikilinkDisplayResult = ReactNode | WikilinkDisplayParts

export interface WikilinkDisplayDecorator {
  /** Diagnostic id, also distinguishes decorators in tests. */
  readonly id: string
  decorate: (context: WikilinkDisplayContext) => WikilinkDisplayResult | null
}

const isWikilinkDisplayDecorator = (value: unknown): value is WikilinkDisplayDecorator =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as WikilinkDisplayDecorator).id === 'string' &&
  typeof (value as WikilinkDisplayDecorator).decorate === 'function'

export const wikilinkDisplayDecoratorFacet = defineFacet<
  WikilinkDisplayDecorator,
  readonly WikilinkDisplayDecorator[]
>({
  id: 'references.wikilink-display-decorator',
  validate: isWikilinkDisplayDecorator,
})

export const isWikilinkDisplayParts = (
  value: WikilinkDisplayResult | null,
): value is WikilinkDisplayParts =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !isValidElement(value) &&
  'content' in value

/** First decorator (in precedence order) to return a non-null display,
 *  or null if every decorator passes. Mirrors `pickBlockDateAdapter`'s
 *  first-match semantics. */
export const resolveWikilinkDisplay = (
  runtime: FacetRuntime,
  context: WikilinkDisplayContext,
): WikilinkDisplayResult | null => {
  const decorators = runtime.read(wikilinkDisplayDecoratorFacet)
  for (const decorator of decorators) {
    const result = decorator.decorate(context)
    if (result != null) return result
  }
  return null
}
