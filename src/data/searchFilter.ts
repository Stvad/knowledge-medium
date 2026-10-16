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

/** Whether `filter` excludes anything — an empty one is no filter, so every
 *  source still takes part. */
export const isActiveSearchFilter = (filter: BlockSearchFilter | undefined): filter is BlockSearchFilter =>
  filter !== undefined && (
    (filter.types !== undefined && filter.types.length > 0)
    || (filter.excludeTypes !== undefined && filter.excludeTypes.length > 0)
    || filter.underId !== undefined
  )
