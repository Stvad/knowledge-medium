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
}

export interface ApplyContentReplaceResult {
  updatedBlocks: number
  replacements: number
  skippedChangedBlocks: number
  skippedUnavailableBlocks: number
  /** Rows skipped because the replacement text would leave a property VALUE
   *  child unparseable under its codec (#404 item 5) — the original,
   *  still-valid content is left untouched rather than writing a broken
   *  value. See `applyContentReplaceMutator`. */
  skippedUnparseableProperty: number
  /** Names of the properties those skips belong to, sorted — so the caller's
   *  summary can say WHICH property refused the text, not just how many rows
   *  it skipped. Empty unless `skippedUnparseableProperty > 0`. */
  unparseableProperties: string[]
}
