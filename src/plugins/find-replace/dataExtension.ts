import { z } from 'zod'
import {
  ChangeScope,
  defineMutator,
  defineQuery,
  type Schema,
} from '@/data/api'
import { mutatorsFacet, queriesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import {
  KERNEL_CONTENT_CHANNEL,
  kernelContentKey,
} from '@/data/internals/kernelInvalidation.js'
import {
  DEFAULT_FIND_REPLACE_OPTIONS,
  buildContentSearchMatch,
  replaceLiteralMatches,
} from './search.ts'
import type {
  ApplyContentReplaceArgs,
  ApplyContentReplaceResult,
  ContentSearchResult,
  FindReplaceOptions,
} from './types.ts'

export const FIND_REPLACE_SEARCH_CONTENT_QUERY = 'findReplace.searchContent'
export const FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR = 'findReplace.applyContentReplace'

export const DEFAULT_FIND_REPLACE_MAX_BLOCKS = 500
const MAX_FIND_REPLACE_MAX_BLOCKS = 500
const CANDIDATE_MULTIPLIER = 20
const MAX_CANDIDATES = 5000

const findReplaceOptionsSchema = z.object({
  matchCase: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
})

const normalizeOptions = (
  options: Partial<FindReplaceOptions> | undefined,
): FindReplaceOptions => ({
  matchCase: options?.matchCase ?? DEFAULT_FIND_REPLACE_OPTIONS.matchCase,
  wholeWord: options?.wholeWord ?? DEFAULT_FIND_REPLACE_OPTIONS.wholeWord,
})

const normalizeMaxBlocks = (maxBlocks: number | undefined): number =>
  Math.max(1, Math.min(maxBlocks ?? DEFAULT_FIND_REPLACE_MAX_BLOCKS, MAX_FIND_REPLACE_MAX_BLOCKS))

const contentSearchResultSchema: Schema<ContentSearchResult> = {
  parse: (input) => input as ContentSearchResult,
}

const applyContentReplaceResultSchema: Schema<ApplyContentReplaceResult> = {
  parse: (input) => input as ApplyContentReplaceResult,
}

const searchContentArgsSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),
  options: findReplaceOptionsSchema.optional(),
  maxBlocks: z.number().optional(),
})

const applyContentReplaceArgsSchema = z.object({
  workspaceId: z.string(),
  find: z.string(),
  replace: z.string(),
  options: findReplaceOptionsSchema,
  items: z.array(z.object({
    blockId: z.string(),
    originalContent: z.string(),
  })),
}) as unknown as Schema<ApplyContentReplaceArgs>

interface ContentCandidateRow {
  id: string
  content: string
}

const SELECT_CONTENT_CANDIDATES_SQL = `
  SELECT id, content
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
    AND (
      (? != 0 AND instr(content, ?) > 0)
      OR (? = 0 AND instr(LOWER(content), LOWER(?)) > 0)
    )
  ORDER BY updated_at DESC, id ASC
  LIMIT ?
`

export const searchContentQuery = defineQuery<
  z.infer<typeof searchContentArgsSchema>,
  ContentSearchResult
>({
  name: FIND_REPLACE_SEARCH_CONTENT_QUERY,
  argsSchema: searchContentArgsSchema,
  resultSchema: contentSearchResultSchema,
  resolve: async ({workspaceId, query, options, maxBlocks}, ctx) => {
    const trimmed = query.trim()
    if (!workspaceId || !trimmed) {
      return {query: trimmed, matches: [], truncated: false}
    }

    const normalizedOptions = normalizeOptions(options)
    const normalizedMaxBlocks = normalizeMaxBlocks(maxBlocks)
    const candidateLimit = Math.min(
      normalizedMaxBlocks * CANDIDATE_MULTIPLIER,
      MAX_CANDIDATES,
    )

    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_CONTENT_CHANNEL,
      key: kernelContentKey(workspaceId),
    })

    const matchCase = normalizedOptions.matchCase ? 1 : 0
    const rows = await ctx.db.getAll<ContentCandidateRow>(
      SELECT_CONTENT_CANDIDATES_SQL,
      [workspaceId, matchCase, trimmed, matchCase, trimmed, candidateLimit + 1],
    )
    const candidateRows = rows.slice(0, candidateLimit)
    const matches = candidateRows
      .map(row => buildContentSearchMatch(row.id, row.content, trimmed, normalizedOptions))
      .filter((match): match is NonNullable<typeof match> => match !== null)

    return {
      query: trimmed,
      matches: matches.slice(0, normalizedMaxBlocks),
      truncated: rows.length > candidateLimit || matches.length > normalizedMaxBlocks,
    }
  },
})

export const applyContentReplaceMutator = defineMutator<
  ApplyContentReplaceArgs,
  ApplyContentReplaceResult
>({
  name: FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  argsSchema: applyContentReplaceArgsSchema,
  resultSchema: applyContentReplaceResultSchema,
  scope: ChangeScope.BlockDefault,
  describe: ({items}) => `replace content across ${items.length} blocks`,
  apply: async (tx, args) => {
    const find = args.find.trim()
    if (!find) {
      return {
        updatedBlocks: 0,
        replacements: 0,
        skippedChangedBlocks: 0,
        skippedUnavailableBlocks: 0,
      }
    }

    const seen = new Set<string>()
    const options = normalizeOptions(args.options)
    const result: ApplyContentReplaceResult = {
      updatedBlocks: 0,
      replacements: 0,
      skippedChangedBlocks: 0,
      skippedUnavailableBlocks: 0,
    }

    for (const item of args.items) {
      if (seen.has(item.blockId)) continue
      seen.add(item.blockId)

      const current = await tx.get(item.blockId)
      if (current === null || current.deleted || current.workspaceId !== args.workspaceId) {
        result.skippedUnavailableBlocks += 1
        continue
      }
      if (current.content !== item.originalContent) {
        result.skippedChangedBlocks += 1
        continue
      }

      const replaced = replaceLiteralMatches(
        current.content,
        find,
        args.replace,
        options,
      )
      if (replaced.replacementCount === 0) continue

      await tx.update(current.id, {content: replaced.content})
      result.updatedBlocks += 1
      result.replacements += replaced.replacementCount
    }

    return result
  },
})

export const findReplaceDataExtension: AppExtension = [
  queriesFacet.of(searchContentQuery, {source: 'find-replace'}),
  mutatorsFacet.of(applyContentReplaceMutator, {source: 'find-replace'}),
]

declare module '@/data/api' {
  interface QueryRegistry {
    [FIND_REPLACE_SEARCH_CONTENT_QUERY]: typeof searchContentQuery
  }

  interface MutatorRegistry {
    [FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR]: typeof applyContentReplaceMutator
  }
}
