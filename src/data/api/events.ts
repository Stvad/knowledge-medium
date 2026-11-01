/** Engine-emitted event shapes. v1 only emits `cycleDetected` from the
 *  Layout B sync observer when sync-applied parent_id mutations close a
 *  loop; it surfaces as a `console.warn` (operators grep logs) plus an
 *  optional `onCycleDetected` callback on `SyncObserverOptions` for
 *  tests / future telemetry hooks. No pub/sub plumbing lives on `Repo`
 *  itself in v1 — there are no in-product subscribers and the alpha
 *  policy is "operator runs the §4.7 SQL runbook to fix manually". */

export interface CycleDetectedEvent {
  workspaceId: string
  /** Affected ids that participate in cycles (each row that closes back
   *  on itself; full cycle members enumerated via the runbook in §4.7). */
  startIds: string[]
  /** tx_ids involved in detection. Always empty for the sync-applied case
   *  (PowerSync's CRUD-apply / the observer's materialize write carry no
   *  tx_id); the field exists for completeness. */
  txIdsInvolved: string[]
}

export const CORE_BLOCK_MERGED_EVENT = 'core.blockMerged' as const

export interface BlockMergeAliasRewrite {
  fromAlias: string
  toAlias: string
}

export interface CoreBlockMergedEvent {
  workspaceId: string
  /** The block whose data was folded into `intoId` and then soft-deleted. */
  fromId: string
  /** The block that absorbed `fromId`. */
  intoId: string
  /** Alias display rewrites that should be applied while retargeting
   *  references. Empty for ordinary core merges; populated by alias
   *  collision merges that need a dropped source alias to render as the
   *  collision alias. */
  aliasRewrites: readonly BlockMergeAliasRewrite[]
}

export const CORE_BLOCK_SPLIT_EVENT = 'core.blockSplit' as const

/** A stretch of a split block's text and the block that now holds it, as its
 *  whole content. */
export interface BlockSplitPiece {
  blockId: string
  /** `[start, end)` of the split's `content`. */
  start: number
  end: number
}

/** One block's text cut into pieces, each now the whole content of a block;
 *  one piece keeps the split block's id. Lets whatever addresses a block's
 *  text by id and offset follow that text in the split's own transaction. */
export interface CoreBlockSplitEvent {
  workspaceId: string
  /** The block that was split. */
  blockId: string
  /** Its text as the split cut it: the caller's live text, which can be ahead
   *  of the stored row. */
  content: string
  /** In text order, covering `content` exactly. */
  pieces: readonly BlockSplitPiece[]
}

export const CORE_BLOCK_DELETED_EVENT = 'core.blockDeleted' as const

export interface CoreBlockDeletedEvent {
  workspaceId: string
  /** The block that was soft-deleted. Soft-delete only flips `deleted`,
   *  so the row still carries `content` — same-tx consumers read it back
   *  via `tx.get` to inline into blocks that referenced it. */
  blockId: string
}

declare module './sameTxProcessor' {
  interface SameTxEventRegistry {
    'core.blockMerged': CoreBlockMergedEvent
    'core.blockSplit': CoreBlockSplitEvent
    'core.blockDeleted': CoreBlockDeletedEvent
  }
}
