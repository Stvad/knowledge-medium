import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { BlockRefError, resolveBlockRef, type BlockRefResolution } from './resolveRef.ts'
import { formatPropertyPairs, type PropertyDetail, type PropertyLine, type PropertyRenderer } from './properties.ts'
import { neutralizeDisplayText } from '@knowledge-medium/agent-cli/protocol'
import { clipLine, formatCount, oneLine } from './text.ts'

/** One block as a view row: everything a line needs, already bounded. */
export interface ViewRow {
  id: string
  shortId: string
  /** One line, cut to the view's per-row budget (`cut` says by how much). */
  content: string
  cut: number
  types: string[]
  properties: PropertyLine[]
  /** Properties past the renderer's cap, counted into the line's `+N props`. */
  omittedProperties: number
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
  const properties = detail === 'none' ? {visible: [], omitted: 0} : renderer.view(block, detail)
  return {
    id: block.id,
    shortId: shortIds.get(block.id) ?? block.id,
    content: clipped.text === '' ? EMPTY_CONTENT : clipped.text,
    cut: clipped.cut,
    types: renderer.typeLabels(block),
    properties: properties.visible,
    omittedProperties: properties.omitted,
  }
}

/** The metadata tail of a line: `type:: …` then the property pairs. */
export const metaSuffix = (row: ViewRow, detail: PropertyDetail | 'none'): string => {
  const parts: string[] = []
  if (row.types.length > 0) parts.push(`type:: ${row.types.join(', ')}`)
  if (detail !== 'none' && row.properties.length + row.omittedProperties > 0) {
    parts.push(formatPropertyPairs(row.properties, detail, row.omittedProperties))
  }
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
  workspaceId: string,
  load: (id: string) => Promise<BlockData | undefined>,
): Promise<{root: BlockData, resolution: BlockRefResolution}> => {
  const resolution = await resolveBlockRef(repo, ref, {workspaceId})
  const root = await load(resolution.id)
  if (!root) {
    const [tombstone] = await repo.db.getAll<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [resolution.id])
    const what = resolution.via === 'date' ? `The daily note for "${oneLine(ref)}" (${resolution.id})` : `Block ${resolution.id}`
    throw new BlockRefError(tombstone
      ? `${what} is deleted; restore-block ${resolution.id} brings it back.`
      : resolution.via === 'date'
        ? `${what} has not been created yet.`
        : `${what} does not exist.`)
  }
  // A view decodes with the active workspace's registries; another
  // workspace's block would render with the wrong codecs and visibility.
  if (root.workspaceId !== workspaceId) {
    throw new BlockRefError(
      `Block ${root.id} is in workspace ${root.workspaceId}, not the active one (${workspaceId}). `
      + 'Views read the active workspace only: switch the app to that workspace, or use the raw command (--raw).',
    )
  }
  return {root, resolution}
}

/** Every text view's last step. Each line goes through the shared display
 *  neutralizer whatever it was built from — content, crumbs, type labels,
 *  property names and values all come from user data — so no field can
 *  forge a line or reorder the id printed after it. Multi-line text must be
 *  split into lines BEFORE this, or its breaks are collapsed too. Accepted:
 *  an id carrying such a character (only sync can deliver one) prints
 *  changed and does not resolve back; `format: 'json'` prints it exactly. */
export const joinDisplayLines = (lines: readonly string[]): string =>
  lines.map(neutralizeDisplayText).join('\n')

/** An empty block still occupies a line; say so rather than print nothing. */
export const EMPTY_CONTENT = '(empty)'

export const CUT_LEGEND = '…[+N chars] = cut here; get_block on that id reads the rest.'
