import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { BlockRefError, resolveBlockRef, type BlockRefResolution } from './resolveRef.ts'
import { formatPropertyPairs, type PropertyLine, type PropertyRenderer } from './properties.ts'
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
  {shortIds, renderer, maxChars}: {
    shortIds: ReadonlyMap<string, string>
    renderer: PropertyRenderer
    maxChars: number
  },
): ViewRow => {
  const clipped = clipLine(block.content, maxChars)
  const properties = renderer.view(block)
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
export const metaSuffix = (row: ViewRow): string => {
  const parts: string[] = []
  if (row.types.length > 0) parts.push(`type:: ${row.types.join(', ')}`)
  if (row.properties.length + row.omittedProperties > 0) {
    parts.push(formatPropertyPairs(row.properties, row.omittedProperties))
  }
  return parts.length > 0 ? `  ${parts.join('  ')}` : ''
}

export const crumbLine = (crumbs: readonly string[] | undefined): string =>
  crumbs && crumbs.length > 0 ? crumbs.join(' › ') : '(top level)'

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`

export const clampInt = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(value ?? fallback, max)

const OPEN_WORKSPACE_ONLY = "A view reads only the open workspace, whose registries decode its values"

/** The workspace a view reads: the one open in the app tab serving the call.
 *  A call naming another one is refused rather than answered from this one;
 *  the bridge sends a call naming a workspace to a connected tab that has it
 *  open, when there is one. */
export const viewWorkspace = (repo: Repo, named: string | undefined): string => {
  const open = repo.activeWorkspaceId
  if (named !== undefined && named !== open) {
    throw new Error(
      `Workspace ${oneLine(named)} is not the one open in the app tab serving this call (${oneLine(open ?? 'none')}). `
      + `${OPEN_WORKSPACE_ONLY}, and a call naming a workspace goes to a connected app tab that has it open: `
      + 'open it in a tab and re-run, or use a raw command, which reads any workspace.',
    )
  }
  if (!open) throw new Error('No workspace is open in the app tab serving this call.')
  return open
}

/** As much of a view's root as resolving and refusing it reads. */
type RootRow = Pick<BlockData, 'id' | 'workspaceId'>

/** Resolve a view's root and load it, with a not-found message that says
 *  what the ref resolved to — a date names a daily note that may simply not
 *  have been created yet. `load` returns undefined for a deleted block. */
export const loadRoot = async <Root extends RootRow>(
  repo: Repo,
  ref: string,
  workspaceId: string,
  load: (id: string) => Promise<Root | undefined>,
): Promise<{root: Root, resolution: BlockRefResolution}> => {
  const resolution = await resolveBlockRef(repo, ref, {workspaceId})
  const root = await load(resolution.id)
  if (!root) {
    const [tombstone] = await repo.db.getAll<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [resolution.id])
    const id = oneLine(resolution.id)
    const what = resolution.via === 'date' ? `The daily note for "${oneLine(ref)}" (${id})` : `Block ${id}`
    throw new BlockRefError(tombstone
      ? `${what} is deleted; restore-block ${id} brings it back.`
      : resolution.via === 'date'
        ? `${what} has not been created yet.`
        : `${what} does not exist.`)
  }
  // Another workspace's block would render with the wrong codecs and visibility.
  if (root.workspaceId !== workspaceId) {
    const home = oneLine(root.workspaceId)
    throw new BlockRefError(
      `Block ${oneLine(root.id)} is in workspace ${home}, not the one open in the app tab serving this call (${oneLine(workspaceId)}). `
      + `${OPEN_WORKSPACE_ONLY}: pass workspaceId ${home} (--workspace) to send the call to an app tab that has it open, `
      + 'or use the raw command (--raw).',
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

export const siblingLines = (siblings: readonly string[] | undefined): string[] =>
  (siblings ?? []).map(sibling => `   ↳ sibling: ${sibling}`)

/** An empty block still occupies a line; say so rather than print nothing. */
export const EMPTY_CONTENT = '(empty)'

export const CUT_LEGEND = '…[+N chars] = cut here; get_block on that id reads the rest.'
