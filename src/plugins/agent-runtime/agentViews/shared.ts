import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { BlockRefError, resolveBlockRef, type BlockRefResolution } from './resolveRef.ts'
import { formatPropertyPairs, type PropertyDetail, type PropertyLine, type PropertyRenderer } from './properties.ts'
import { clipLine, formatCount } from './text.ts'

/** One block as a view row: everything a line needs, already bounded. */
export interface ViewRow {
  id: string
  shortId: string
  /** One line, cut to the view's per-row budget (`cut` says by how much). */
  content: string
  cut: number
  types: string[]
  properties: PropertyLine[]
}

export const toViewRow = (
  block: BlockData,
  {shortIds, renderer, maxChars, detail}: {
    shortIds: ReadonlyMap<string, string>
    renderer: PropertyRenderer
    maxChars: number
    detail: PropertyDetail | 'none'
  },
): ViewRow => {
  const clipped = clipLine(block.content, maxChars)
  return {
    id: block.id,
    shortId: shortIds.get(block.id) ?? block.id,
    content: clipped.text,
    cut: clipped.cut,
    types: renderer.typeLabels(block),
    properties: detail === 'none' ? [] : renderer.view(block, detail).visible,
  }
}

/** The metadata tail of a line: `type:: …` then the property pairs. */
export const metaSuffix = (row: ViewRow, detail: PropertyDetail | 'none'): string => {
  const parts: string[] = []
  if (row.types.length > 0) parts.push(`type:: ${row.types.join(', ')}`)
  if (detail !== 'none' && row.properties.length > 0) parts.push(formatPropertyPairs(row.properties, detail))
  return parts.length > 0 ? `  ${parts.join('  ')}` : ''
}

export const crumbLine = (crumbs: readonly string[] | undefined): string =>
  crumbs && crumbs.length > 0 ? crumbs.join(' › ') : '(top level)'

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`

export const clampInt = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(value ?? fallback, max)

/** Resolve a view's root and load it, with a not-found message that says
 *  what the ref resolved to — a date names a daily note that may simply not
 *  have been created yet. */
export const loadRoot = async (
  repo: Repo,
  ref: string,
  workspaceId: string | null,
  load: (id: string) => Promise<BlockData | undefined>,
): Promise<{root: BlockData, resolution: BlockRefResolution}> => {
  const resolution = await resolveBlockRef(repo, ref, {workspaceId})
  const root = await load(resolution.id)
  if (root) return {root, resolution}
  throw new BlockRefError(resolution.via === 'date'
    ? `The daily note for "${ref}" has not been created yet (its id would be ${resolution.id}).`
    : `Block ${resolution.id} does not exist or is deleted.`)
}

export const CUT_LEGEND = '…[+N chars] = cut here; get_block on that id reads the rest.'
