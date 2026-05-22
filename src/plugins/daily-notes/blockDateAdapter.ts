/**
 * Adapter facet that lets plugins teach the date-shift UI how to read
 * and write a block's date. Decouples UI components (the calendar sheet,
 * the long-press scrub gesture) from the per-block-kind storage details.
 *
 * Why a facet rather than direct imports?
 * - daily-notes can't import srs-rescheduling without a layering cycle
 *   (srs-rescheduling already depends on daily-notes for daily-note
 *   resolution).
 * - The existing `actionDecoratorsFacet` pattern only handles
 *   parameter-less actions ("shift +1d"). Picking an absolute ISO from
 *   a calendar can't go through that channel without inventing a
 *   parameter passing mechanism.
 *
 * Adapters are queried via `pickBlockDateAdapter(runtime, block)` which
 * returns the first matching adapter in precedence order — so SRS
 * (registered with negative precedence) wins over the generic
 * date-reference adapter on blocks that satisfy both.
 */
import type { Block } from '@/data/block'
import { defineFacet, type FacetRuntime } from '@/extensions/facet.js'

export interface BlockDateAdapter {
  /** Diagnostic id, also distinguishes adapters in tests. */
  readonly id: string
  /** Sync predicate over `block.peek()` — used by `canRun` gates and
   *  the swipe-menu visibility filter, which both run during render. */
  canHandle: (block: Block) => boolean
  /** Resolves the ISO (`YYYY-MM-DD`) the adapter is currently representing
   *  for this block. Async because some adapters (SRS) need to load a
   *  related row. Returns null if the adapter can't resolve a date right
   *  now (e.g. SRS row exists but the next-review reference is dangling). */
  getCurrentIso: (block: Block) => Promise<string | null>
  /** Move this block's date to `iso`. Returns false if the write was
   *  refused (read-only repo, lost type, etc.) so the caller can
   *  surface a "no-op" state without throwing. */
  setIso: (block: Block, iso: string) => Promise<boolean>
}

const isBlockDateAdapter = (value: unknown): value is BlockDateAdapter =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as BlockDateAdapter).id === 'string' &&
  typeof (value as BlockDateAdapter).canHandle === 'function' &&
  typeof (value as BlockDateAdapter).getCurrentIso === 'function' &&
  typeof (value as BlockDateAdapter).setIso === 'function'

export const blockDateAdapterFacet = defineFacet<BlockDateAdapter, readonly BlockDateAdapter[]>({
  id: 'daily-notes.block-date-adapter',
  validate: isBlockDateAdapter,
})

/** First adapter (in precedence order) whose `canHandle` returns true,
 *  or null if none apply. The picker / scrub gesture call this once
 *  when they activate; the chosen adapter handles both the initial read
 *  and the eventual commit. */
export const pickBlockDateAdapter = (
  runtime: FacetRuntime,
  block: Block,
): BlockDateAdapter | null => {
  const adapters = runtime.read(blockDateAdapterFacet)
  for (const adapter of adapters) {
    if (adapter.canHandle(block)) return adapter
  }
  return null
}

export const hasAnyBlockDateAdapter = (
  runtime: FacetRuntime,
  block: Block,
): boolean => pickBlockDateAdapter(runtime, block) !== null
