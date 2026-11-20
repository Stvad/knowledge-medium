/*
 * What a block's references show in the app, for views that print its raw
 * content: a plain `((id))` displays its target's text and an embed displays
 * the target block itself, so a view printing only the id shows an agent less
 * than a person reading the same page. Everything this adds goes on lines of
 * its own after the row, never into the content (agents copy a view's content
 * into `edit_block` passages and `expectedContent`) and never after the row's
 * `^id` (the id is the last thing on its line).
 */
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import { isPageEmbed, parseBlockRefs, parseOutermostReferences } from '@/plugins/references/referenceParser.js'
import { loadBlocks, loadContentHeads, visibleChildCounts } from './context.ts'
import { ellipsize, formatCount, oneLine } from './text.ts'

export interface ExpandRefsParam {
  /** Show what references display in the app (default true). */
  expandRefs?: boolean
}

export const expandsRefs = (params: ExpandRefsParam): boolean => params.expandRefs !== false

/** A mark the views resolve. An aliased `[label](((id)))` displays its label
 *  and a `[[Page]]` link its name, so neither is one — except the aliased
 *  form with an empty label, which the renderer shows as its target's text. */
export type ContentMark =
  | {kind: 'ref' | 'embed', id: string}
  | {kind: 'page-embed', alias: string}

/** Cheap pre-checks, so the common block (no reference, no code) parses nothing. */
const MAYBE_MARK = /\(\(|!\[\[/
const MAYBE_CODE = /`|~~~|^(?: {4}|\t)/m

/** `content` with its code spans and blocks blanked, offsets kept: the
 *  renderer shows a reference inside code as literal text. */
const withoutCode = (content: string): string => {
  if (!MAYBE_CODE.test(content)) return content
  const ranges: Array<[number, number]> = []
  visit(unified().use(remarkParse).parse(content), ['code', 'inlineCode'], node => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) ranges.push([start, end])
  })
  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    out += content.slice(cursor, start) + content.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return out + content.slice(cursor)
}

/** Distinct marks in the order they appear. */
export const contentMarks = (content: string): ContentMark[] => {
  if (!MAYBE_MARK.test(content)) return []
  const text = withoutCode(content)
  const found: Array<{at: number, mark: ContentMark, key: string}> = []
  for (const ref of parseBlockRefs(text)) {
    if (ref.label) continue
    const kind = ref.embed ? 'embed' : 'ref'
    found.push({at: ref.startIndex, mark: {kind, id: ref.blockId}, key: `${kind}:${ref.blockId}`})
  }
  for (const ref of parseOutermostReferences(text)) {
    if (!isPageEmbed(text, ref)) continue
    found.push({at: ref.startIndex, mark: {kind: 'page-embed', alias: ref.alias}, key: `page-embed:${ref.alias}`})
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.at - b.at)
    .filter(({key}) => !seen.has(key) && Boolean(seen.add(key)))
    .map(({mark}) => mark)
}

export interface RefNote {
  kind: 'ref' | 'embed'
  id: string
  /** One line of the target's text; null when no live block of the workspace has the id. */
  preview: string | null
}

export interface RowRefs {
  refs: RefNote[]
  /** Marks past the per-row cap. */
  omittedRefs: number
}

export const NO_REFS: RowRefs = {refs: [], omittedRefs: 0}

export interface RefRow {
  id: string
  content: string
  /** Ids not to note: the view's own target, or an embed it shows as rows. */
  skip?: ReadonlySet<string>
}

const PREVIEW_CHARS = 60
/** Read per target: roomy, so collapsing whitespace rarely leaves less than a preview. */
const HEAD_CHARS = PREVIEW_CHARS * 4
/** A list row's notes; a row is one of a page of many. */
const ROW_REFS = 3

type BlockMark = Extract<ContentMark, {kind: 'ref' | 'embed'}>

/** Each row's notes, by row id: its first `max` block marks outside `skip`,
 *  in one read of just those targets. A page embed gets none: its content
 *  already names the page, which is all a preview of it would say. */
export const resolveRowRefs = async (
  repo: Repo,
  workspaceId: string,
  rows: readonly RefRow[],
  params: ExpandRefsParam,
  max = ROW_REFS,
): Promise<Map<string, RowRefs>> => {
  if (!expandsRefs(params)) return new Map()
  const picked = rows.map(row => {
    const marks = contentMarks(row.content)
      .filter((mark): mark is BlockMark => mark.kind !== 'page-embed' && !row.skip?.has(mark.id))
    return {id: row.id, marks: marks.slice(0, max), omitted: Math.max(0, marks.length - max)}
  })
  const ids = [...new Set(picked.flatMap(row => row.marks.map(mark => mark.id)))]
  const heads = ids.length > 0 ? await loadContentHeads(repo, ids, HEAD_CHARS) : new Map()
  const preview = (id: string): string | null => {
    const head = heads.get(id)
    // A sync-applied row can name a block of another workspace; it is not this one's to show.
    if (!head || head.workspaceId !== workspaceId) return null
    return ellipsize(oneLine(head.content), PREVIEW_CHARS)
  }
  return new Map(picked.map(row => [row.id, {
    refs: row.marks.map(mark => ({kind: mark.kind, id: mark.id, preview: preview(mark.id)})),
    omittedRefs: row.omitted,
  }]))
}

/** JSON-quoted, so a preview can never close its quote and pass for a second note. */
const noteText = (note: RefNote): string => {
  const mark = note.kind === 'embed' ? `!((${note.id}))` : `((${note.id}))`
  return `↳ ${mark} ${note.preview === null ? '(no such block)' : JSON.stringify(note.preview)}`
}

/** A row's notes as lines of their own, each starting with `indent`. */
export const refLines = ({refs, omittedRefs}: RowRefs, indent = ''): string[] => [
  ...refs.map(note => `${indent}${noteText(note)}`),
  ...(omittedRefs > 0 ? [`${indent}↳ +${formatCount(omittedRefs)} more refs`] : []),
]

export const REFS_LEGEND = '↳ ((id)) "…" = the text that reference shows in the app; it is not part of the block\'s content.'

/** The blocks `hosts` embed that a level of the outline can show: in host
 *  then mark order, none `placed`, each once, at most `budget`, and each a
 *  live block of the workspace with its visible child count. Only those are
 *  read. A page embed resolves its name as a page link does. */
export const loadEmbedTargets = async (
  repo: Repo,
  workspaceId: string,
  hosts: readonly BlockData[],
  {budget, placed}: {budget: number, placed: (id: string) => boolean},
): Promise<Array<{hostId: string, block: BlockData, childCount: number}>> => {
  const picks: Array<{hostId: string, id: string}> = []
  const picked = new Set<string>()
  const pageIds = new Map<string, string | null>()
  const pageId = async (alias: string): Promise<string | null> => {
    if (!pageIds.has(alias)) {
      const page = await repo.query.aliasLookup({workspaceId, alias}).load() as BlockData | null
      pageIds.set(alias, page?.id ?? null)
    }
    return pageIds.get(alias)!
  }
  for (const host of hosts) {
    for (const mark of contentMarks(host.content)) {
      if (picks.length >= budget) break
      if (mark.kind === 'ref') continue
      const id = mark.kind === 'page-embed' ? await pageId(mark.alias) : mark.id
      if (id === null || placed(id) || picked.has(id)) continue
      picked.add(id)
      picks.push({hostId: host.id, id})
    }
  }
  if (picks.length === 0) return []
  const ids = picks.map(pick => pick.id)
  const [blocks, counts] = await Promise.all([loadBlocks(repo, ids, {workspaceId}), visibleChildCounts(repo, ids, workspaceId)])
  const byId = new Map(blocks.map(block => [block.id, block]))
  return picks.flatMap(({hostId, id}) => {
    const block = byId.get(id)
    return block ? [{hostId, block, childCount: counts.get(id) ?? 0}] : []
  })
}
