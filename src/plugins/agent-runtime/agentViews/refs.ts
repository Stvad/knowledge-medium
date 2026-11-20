/*
 * What a block's references show in the app, for views that print its raw
 * content: a plain `((id))` displays its target's text and an embed displays
 * the target block itself, so a view printing only the id shows an agent less
 * than a person reading the same page. A reference's preview is printed AFTER
 * the line, never spliced into the content: agents copy a view's content into
 * `edit_block` passages and `expectedContent`.
 */
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { parseBlockRefs, parseOutermostReferences } from '@/plugins/references/referenceParser.js'
import { loadContentHeads } from './context.ts'
import { ellipsize, formatCount, oneLine } from './text.ts'

/** A mark the views resolve. An aliased `[label](((id)))` displays its label
 *  and a `[[Page]]` link its name, so neither is one — except the aliased
 *  form with an empty label, which the renderer shows as its target's text. */
export type ContentMark =
  | {kind: 'ref' | 'embed', id: string}
  | {kind: 'page-embed', alias: string}

/** Distinct marks in the order they appear. */
export const contentMarks = (content: string): ContentMark[] => {
  const found: Array<{at: number, mark: ContentMark, key: string}> = []
  for (const ref of parseBlockRefs(content)) {
    if (ref.label) continue
    const kind = ref.embed ? 'embed' : 'ref'
    found.push({at: ref.startIndex, mark: {kind, id: ref.blockId}, key: `${kind}:${ref.blockId}`})
  }
  for (const ref of parseOutermostReferences(content)) {
    if (ref.startIndex === 0 || content[ref.startIndex - 1] !== '!') continue
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

export interface RefResolver {
  /** The notes for `content`'s block marks, leaving out the ids in `skip`
   *  (the view's own target, or an embed the view already shows as rows). */
  notes(content: string, max: number, skip?: ReadonlySet<string>): RowRefs
}

const PREVIEW_CHARS = 60
/** Read per target: roomy, so collapsing whitespace rarely leaves less than a preview. */
const HEAD_CHARS = PREVIEW_CHARS * 4
/** A row's notes; a list row is one line of a page of many. */
export const ROW_REFS = 3

const NO_REFS: RefResolver = {notes: () => ({refs: [], omittedRefs: 0})}

const blockMarkIds = (content: string): string[] =>
  contentMarks(content).flatMap(mark => mark.kind === 'page-embed' ? [] : [mark.id])

/** One read for every target the contents name. `enabled: false` (the
 *  views' `expandRefs: false`) reads nothing and notes nothing. */
export const createRefResolver = async (
  repo: Repo,
  workspaceId: string,
  contents: readonly string[],
  enabled: boolean,
): Promise<RefResolver> => {
  if (!enabled) return NO_REFS
  const ids = [...new Set(contents.flatMap(blockMarkIds))]
  if (ids.length === 0) return NO_REFS
  const heads = await loadContentHeads(repo, ids, HEAD_CHARS)
  const preview = (id: string): string | null => {
    const head = heads.get(id)
    // A sync-applied row can name a block of another workspace; it is not this one's to show.
    if (!head || head.workspaceId !== workspaceId) return null
    return ellipsize(oneLine(head.content), PREVIEW_CHARS)
  }
  return {
    notes: (content, max, skip) => {
      const marks = contentMarks(content).flatMap(mark =>
        mark.kind === 'page-embed' || skip?.has(mark.id) ? [] : [mark])
      return {
        refs: marks.slice(0, max).map(mark => ({kind: mark.kind, id: mark.id, preview: preview(mark.id)})),
        omittedRefs: Math.max(0, marks.length - max),
      }
    },
  }
}

const noteText = (note: RefNote): string => {
  const mark = note.kind === 'embed' ? `!((${note.id}))` : `((${note.id}))`
  if (note.preview === null) return `${mark} (no such block)`
  return `${mark} ${note.preview === '' ? '(empty)' : `"${note.preview}"`}`
}

/** The notes as a line's tail, after its id. */
export const refSuffix = ({refs, omittedRefs}: RowRefs): string => {
  if (refs.length === 0 && omittedRefs === 0) return ''
  const more = omittedRefs > 0 ? `  (+${formatCount(omittedRefs)} more refs)` : ''
  return `${refs.map(note => `  ↳ ${noteText(note)}`).join('')}${more}`
}

/** The notes as lines of their own, for a view that prints a block whole. */
export const refLines = ({refs, omittedRefs}: RowRefs): string[] => [
  ...refs.map(note => `↳ ${noteText(note)}`),
  ...(omittedRefs > 0 ? [`(+${formatCount(omittedRefs)} more refs)`] : []),
]

export const REFS_LEGEND = '↳ ((id)) "…" = the text that reference shows in the app; it is not part of the block\'s content.'

/** The blocks `hosts`' content embeds, by host, in mark order: live blocks of
 *  the workspace, each with its visible child count. A page embed resolves
 *  its name as a page link does. */
export const loadEmbedTargets = async (
  repo: Repo,
  workspaceId: string,
  hosts: readonly BlockData[],
  load: (ids: readonly string[]) => Promise<Array<{block: BlockData, childCount: number}>>,
): Promise<Map<string, Array<{block: BlockData, childCount: number}>>> => {
  const marksByHost = new Map<string, ContentMark[]>()
  for (const host of hosts) {
    const embeds = contentMarks(host.content).filter(mark => mark.kind !== 'ref')
    if (embeds.length > 0) marksByHost.set(host.id, embeds)
  }
  if (marksByHost.size === 0) return new Map()
  const aliases = [...new Set([...marksByHost.values()].flat().flatMap(mark => mark.kind === 'page-embed' ? [mark.alias] : []))]
  const aliasIds = new Map<string, string>()
  await Promise.all(aliases.map(async alias => {
    const page = await repo.query.aliasLookup({workspaceId, alias}).load() as BlockData | null
    if (page) aliasIds.set(alias, page.id)
  }))
  const targetId = (mark: ContentMark): string | undefined =>
    mark.kind === 'page-embed' ? aliasIds.get(mark.alias) : mark.id
  const ids = [...new Set([...marksByHost.values()].flat().flatMap(mark => targetId(mark) ?? []))]
  const loaded = new Map((await load(ids)).map(row => [row.block.id, row]))
  return new Map([...marksByHost].map(([hostId, marks]) => [
    hostId,
    marks.flatMap(mark => {
      const id = targetId(mark)
      const row = id === undefined ? undefined : loaded.get(id)
      return row ? [row] : []
    }),
  ]))
}
