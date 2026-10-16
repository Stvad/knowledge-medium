/** Narrows a search to the blocks that pass every given clause. A source
 *  applies it INSIDE its own query, before its limit, so a filtered page is
 *  full whenever enough matches exist. */
export interface BlockSearchFilter {
  /** Blocks carrying ANY of these type ids. */
  readonly types?: ReadonlyArray<string>
  /** Blocks carrying NONE of these type ids. */
  readonly excludeTypes?: ReadonlyArray<string>
  /** Strict descendants of this block. */
  readonly underId?: string
}

/** The type clauses on one block's type ids. The merge point applies them to
 *  a source that does not filter itself; ancestry (`underId`) cannot be
 *  checked from a candidate, so such a source sits out a filter that has it. */
export const matchesTypeFilter = (typeIds: readonly string[], filter: BlockSearchFilter): boolean =>
  (filter.types === undefined || filter.types.length === 0 || filter.types.some(type => typeIds.includes(type)))
  && !(filter.excludeTypes ?? []).some(type => typeIds.includes(type))

/** Whether `filter` excludes anything — an empty one is no filter. */
export const isActiveSearchFilter = (filter: BlockSearchFilter | undefined): filter is BlockSearchFilter =>
  filter !== undefined && (
    (filter.types !== undefined && filter.types.length > 0)
    || (filter.excludeTypes !== undefined && filter.excludeTypes.length > 0)
    || filter.underId !== undefined
  )
