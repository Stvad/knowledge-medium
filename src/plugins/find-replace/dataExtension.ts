import { z } from 'zod'
import {
  ChangeScope,
  defineMutator,
  defineQuery,
  type Schema,
} from '@/data/api'
import { mutatorsFacet, queriesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  KERNEL_CONTENT_CHANNEL,
  kernelContentKey,
} from '@/data/invalidation'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from '@/data/internals/referenceTargetProcessor'
import {
  propertyChildContentToEncodedValue,
  resolvePropertyValueFieldSchema,
} from '@/data/propertyChildren'
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
  force: z.boolean().optional(),
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
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
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

const emptyResult = (): ApplyContentReplaceResult => ({
  updatedBlocks: 0,
  replacements: 0,
  skippedChangedBlocks: 0,
  skippedUnavailableBlocks: 0,
  skippedUnparseableProperty: 0,
  unparseableProperties: [],
  retryableSkips: [],
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
    if (!find) return emptyResult()

    const seen = new Set<string>()
    const options = normalizeOptions(args.options)
    const force = args.force === true
    const result = emptyResult()
    // #404 item 5: which properties were skipped, so the caller's summary can
    // name them (the dialog renders this result directly).
    const unparseableProperties = new Set<string>()

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

      // A FIELD row (content `((fieldId))`) is deliberately NOT special-cased.
      // Find-replace is a content edit, and editing a field row's content is
      // the same operation as editing it directly in the outline: the
      // derive/project pass re-roles the property deterministically and
      // visibly, exactly as a direct edit or a move does — the intended
      // everything-is-a-block semantics (§9/§10). There is no invisible
      // failure to guard (the row's own content visibly changed) and no codec
      // to break (its content is a ref, not a typed value), so a field row
      // falls through to the ordinary write below like any other block. (Only
      // VALUE rows get the codec skip — see below — because a broken value
      // fails SILENTLY: the key drops from the owner's cell with no error.)
      //
      // #404 item 5: under properties-as-blocks (PR #288 §9), a property
      // VALUE child's `content` IS its typed value — writing straight
      // through here can leave it unparseable under its codec (a
      // `number`/`date`/`boolean` value in particular), and PROJECT's
      // `firstProjectedFieldValue` would then silently skip the child and
      // drop the property key from the owner's cell, with no error
      // surfaced to the user who ran the replace.
      //
      // Default: SKIP the write rather than write-then-report, matching the
      // §9 migration precedent (`runPropertyDefinitionMigrationBatch`) — it
      // never writes a value it can't convert, preserving the original
      // (still-valid) text. Writing the broken text would be "replace
      // succeeded, property silently detached". The skip is returned in
      // `retryableSkips` so the caller can offer "replace anyway"; on that
      // forced re-run the write goes through and the property reads unset
      // (visible in the value row, undo-recoverable) until the text is fixed.
      //
      // Dormant un-flipped: both recognizers return false/null whenever the
      // workspace isn't child-backed (no field rows are ever recognized), so
      // this whole section is a no-op there.
      const schema = await resolvePropertyValueFieldSchema(tx, current)
      if (schema !== null && !force) {
        // Ref-typed values are validated against the target the PROPOSED
        // content would derive (not the stale pre-replace column) — same-tx
        // `core.deriveReferenceTarget` hasn't run yet at this point in the
        // pipeline, so the column still reflects the OLD content.
        const projectedTargetId = schema.codec.type === 'ref'
          ? (await deriveReferenceColumns(
              replaced.content, current.workspaceId, sameTxReferenceTargetLookups(tx),
            )).targetId ?? null
          : current.referenceTargetId ?? null
        const breaksCodec = (() => {
          try {
            propertyChildContentToEncodedValue(schema, replaced.content, projectedTargetId)
            return false
          } catch {
            return true
          }
        })()
        if (breaksCodec) {
          result.skippedUnparseableProperty += 1
          unparseableProperties.add(schema.name)
          result.retryableSkips.push({
            blockId: current.id,
            originalContent: current.content,
            property: schema.name,
          })
          continue
        }
      }

      await tx.update(current.id, {content: replaced.content})
      result.updatedBlocks += 1
      result.replacements += replaced.replacementCount
    }

    result.unparseableProperties = [...unparseableProperties].sort()

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
