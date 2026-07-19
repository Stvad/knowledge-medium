export interface FindReplaceOptions {
  matchCase: boolean
  wholeWord: boolean
}

export interface ContentSearchMatch {
  blockId: string
  originalContent: string
  matchCount: number
  preview: string
}

export interface ContentSearchResult {
  query: string
  matches: ContentSearchMatch[]
  truncated: boolean
}

export interface ContentReplacePlanItem {
  blockId: string
  originalContent: string
}

export interface ApplyContentReplaceArgs {
  workspaceId: string
  find: string
  replace: string
  options: FindReplaceOptions
  items: ContentReplacePlanItem[]
  /** Write property VALUE rows even when the replacement won't decode under
   *  the property's codec (#404 item 5). The safe default (unset/false) skips
   *  those rows and returns them in `retryableSkips`; the caller re-runs THAT
   *  set with `force: true` after warning the user. Never overrides a FIELD-row
   *  skip — rewriting a field row's `((fieldId))` identity is structurally
   *  destructive, not a value the user can knowingly accept, so it stays a hard
   *  skip regardless. */
  force?: boolean
}

/** A value-row skip the caller may retry with `force: true`. Carries the plan
 *  item verbatim (so the re-run's stale-content guard still applies) plus the
 *  property whose codec refused the text, for the warning copy. */
export interface RetryableContentReplaceSkip {
  blockId: string
  originalContent: string
  property: string
}

export interface ApplyContentReplaceResult {
  updatedBlocks: number
  replacements: number
  skippedChangedBlocks: number
  skippedUnavailableBlocks: number
  /** Rows skipped because the replacement text would leave a property VALUE
   *  child unparseable under its codec, OR because the row is a property FIELD
   *  row whose identity a replacement must never rewrite (#404 item 5) — the
   *  original content is left untouched rather than writing a broken value.
   *  See `applyContentReplaceMutator`. */
  skippedUnparseableProperty: number
  /** Names of the properties those skips belong to, sorted — so the caller's
   *  summary can say WHICH property refused the text, not just how many rows
   *  it skipped. Empty unless `skippedUnparseableProperty > 0`. */
  unparseableProperties: string[]
  /** The value-row subset of the skips above, which a `force: true` re-run
   *  CAN write (the user accepts a temporarily-unreadable property). Excludes
   *  field-row skips, which are never forceable. Empty on a forced run. */
  retryableSkips: RetryableContentReplaceSkip[]
}
