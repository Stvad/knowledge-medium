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
import type { ReactNode } from 'react'
import { defineFacet, type FacetRuntime } from '@/extensions/facet.ts'

export interface WikilinkDisplayContext {
  alias: string
  /** Resolved block id, or '' when the alias didn't match any block. */
  blockId: string
  workspaceId: string
}

export interface WikilinkDisplayDecorator {
  /** Diagnostic id, also distinguishes decorators in tests. */
  readonly id: string
  decorate: (context: WikilinkDisplayContext) => ReactNode | null
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

/** First decorator (in precedence order) to return a non-null display,
 *  or null if every decorator passes. Mirrors `pickBlockDateAdapter`'s
 *  first-match semantics. */
export const resolveWikilinkDisplay = (
  runtime: FacetRuntime,
  context: WikilinkDisplayContext,
): ReactNode | null => {
  const decorators = runtime.read(wikilinkDisplayDecoratorFacet)
  for (const decorator of decorators) {
    const result = decorator.decorate(context)
    if (result != null) return result
  }
  return null
}
