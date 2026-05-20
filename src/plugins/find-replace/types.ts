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
}
