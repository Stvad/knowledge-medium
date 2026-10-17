/**
 * Markdown-native, conflict-safe agent writes: `append-markdown`,
 * `edit-block`, `create-page`. Each refuses inside its writing transaction
 * against the rows current there, so an edit made on another device since the
 * agent read is never clobbered.
 */
import { orderKeysForInsert, type InsertPosition } from '@/data/mutators.js'
import type { Repo } from '@/data/repo'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser.js'
import { parseRelativeDate } from '@/utils/relativeDate.js'
import { AGENT_VIEW_DEFAULTS, charBoundary, createPageName, cutMarker, toDisplayJson } from '@knowledge-medium/agent-cli/protocol'
import { agentTxOptions } from './agentWrites.ts'
import { displayIds } from './agentViews/displayIds.ts'
import { shortIds } from './agentViews/resolveRef.ts'
import { CUT_LEGEND, EMPTY_CONTENT, joinDisplayLines, plural } from './agentViews/shared.ts'
import { clipLine } from './agentViews/text.ts'
import {
  assertAnchorUnder,
  resolveAgentTarget,
  blockIdField,
  blockPositionField,
  resolveDailyNoteTarget,
  resolvePageTarget,
  type ResolvedAgentTarget,
} from './targets.ts'
import { assertActiveWorkspace } from './workspaceGuard.ts'

type MarkdownShape = 'outline' | 'block'

/** Markdown → blocks to create: the app paste parser's split for `'outline'`
 *  (the default), or the whole text as ONE block for `'block'`. */
export const parseAgentMarkdown = (markdown: string, shape: MarkdownShape = 'outline'): ParsedBlock[] =>
  shape === 'block'
    ? (markdown.length === 0 ? [] : [{id: 'block-root', orderKey: '', content: markdown}])
    : parseMarkdownToBlocks(markdown)

interface AppendMarkdownInput {
  target: string
  markdown: string
  position?: InsertPosition
  shape?: MarkdownShape
  /** The anchor's siblingId is already a stored id (see `blockIdField`). */
  exactIds?: boolean
}

/** A block as an append reports it: one display line, cut at the read views'
 *  line budget, and its id as they print it. */
interface AppendedLine {
  shortId: string
  content: string
  /** Characters cut from `content` (0 when it fit). */
  cut: number
}

interface AppendedBlock extends AppendedLine {
  id: string
  parentId: string
  /** 0 for a direct child of the target. */
  depth: number
}

/** What `append-markdown` answers: bounded like a read view, rendered as text
 *  by {@link renderAppendView} unless the call asks for `format: 'json'`. */
interface AppendMarkdownView {
  target: ResolvedAgentTarget & AppendedLine
  /** How many blocks the append created. */
  appended: number
  /** The first of them in pre-order, up to the outline view's limit. */
  blocks: AppendedBlock[]
}

const appendedLine = (content: string, shortId: string): AppendedLine => {
  const clipped = clipLine(content, AGENT_VIEW_DEFAULTS.lineChars)
  return {shortId, content: clipped.text === '' ? EMPTY_CONTENT : clipped.text, cut: clipped.cut}
}

/** `Appended N blocks under <target>  ^short (kind[, created]):`, then the new
 *  blocks as an outline in the read views' line form. */
export const renderAppendView = (view: AppendMarkdownView): string => {
  const {target, appended, blocks} = view
  const facts = target.created ? `${target.kind}, created` : target.kind
  const lines = [
    `Appended ${plural(appended, 'block')} under ${target.content}  ^${target.shortId} (${facts}):`,
    ...blocks.map(block => `${'  '.repeat(block.depth)}- ${block.content}  ^${block.shortId}`),
  ]
  if ([target, ...blocks].some(line => line.cut > 0)) lines.push(CUT_LEGEND)
  const rest = appended - blocks.length
  if (rest > 0) lines.push(`… ${plural(rest, 'more block')} not shown — read them with subtree ^${target.shortId}`)
  return joinDisplayLines(lines)
}

export const appendMarkdown = async (
  outerRepo: Repo,
  input: AppendMarkdownInput,
): Promise<AppendMarkdownView> => {
  const verb = 'append-markdown'
  // Before resolving the target: resolution can CREATE a page.
  if (input.markdown.trim() === '') throw new Error(`${verb}: markdown is empty — nothing to append.`)

  // A created page / daily note commits in its own tx; one undo entry for both.
  return outerRepo.undoGroup(async repo => {
    const firstPosition = await blockPositionField(repo, input.position ?? {kind: 'last'}, verb, input.exactIds)
    // An anchor's parent exists already, so an anchored insert never creates
    // its target; one that is not the anchor's parent is refused before the
    // parse, and again inside the tx below if the anchor moved meanwhile.
    const anchored = firstPosition.kind === 'before' || firstPosition.kind === 'after'
    // Accepted, not made atomic: if the insert below then fails, a page or
    // daily note created here stays — what typing the wikilink or opening that
    // day leaves too; a daily note cannot be created inside the insert's tx.
    const target = await resolveAgentTarget(repo, input.target, verb, {create: !anchored})
    await assertAnchorUnder(repo, firstPosition, target.id, verb)
    // After the target: a refused one should not pay for a large document's
    // parse. Parsing cannot fail, so nothing created above is left orphaned.
    const parsed = parseAgentMarkdown(input.markdown, input.shape)
    const blocks: Array<{id: string, parentId: string, depth: number, content: string}> = []
    let targetContent = ''

    await repo.tx(async tx => {
      const row = await tx.get(target.id)
      if (!row) throw new Error(`${verb}: block ${target.id} not found.`)
      assertActiveWorkspace(repo, verb, row.workspaceId)
      targetContent = row.content
      // The roots' keys in one sibling read (a key per root would rescan the
      // growing list each time). A parsed child keeps the key the parser gave
      // it — its parent is new, so it has no siblings to clear. A deleted
      // target is refused by `tx.create` itself.
      const rootKeys = await orderKeysForInsert(
        tx, row.id, row.workspaceId, firstPosition, parsed.filter(node => !node.parentId).length,
      )
      let nextRoot = 0
      const created = new Map<string, {id: string; depth: number}>()
      for (const node of parsed) {
        const parent = node.parentId ? created.get(node.parentId)! : null
        const parentId = parent?.id ?? row.id
        const id = crypto.randomUUID()
        await tx.create({
          id,
          workspaceId: row.workspaceId,
          parentId,
          orderKey: parent ? node.orderKey : rootKeys[nextRoot++],
          content: node.content,
        })
        const depth = parent ? parent.depth + 1 : 0
        created.set(node.id, {id, depth})
        blocks.push({id, parentId, depth, content: node.content})
      }
    }, agentTxOptions(verb))

    const listed = blocks.slice(0, AGENT_VIEW_DEFAULTS.outlineLimit)
    const ids = await displayIds(repo, [target.id, ...listed.map(block => block.id)])
    return {
      target: {...target, ...appendedLine(targetContent, ids.get(target.id)!)},
      appended: blocks.length,
      blocks: listed.map(({content, ...block}) => ({...block, ...appendedLine(content, ids.get(block.id)!)})),
    }
  })
}

interface EditBlockInput {
  id: string
  old: string
  new: string
  /** `id` is already a stored id (see `blockIdField`). */
  exactIds?: boolean
}

/** Overlapping occurrences — `aa` occurs twice in `aaa`, which is ambiguous to
 *  replace. Bounded by the text length, so an empty needle cannot spin. */
const occurrences = (text: string, needle: string): number => {
  let count = 0
  for (let at = text.indexOf(needle); at >= 0 && at < text.length; at = text.indexOf(needle, at + 1)) count += 1
  return count
}

const CONTENT_ECHO_LIMIT = 1000

/** The block's content as an error shows it: its first CONTENT_ECHO_LIMIT
 *  characters quoted losslessly, so the agent can re-plan from them exactly,
 *  and escaped, so stored text can neither fake a line of the diagnostic nor
 *  reorder it; a longer content ends in the read views' cut marker. */
export const contentEcho = (content: string): string => {
  const end = charBoundary(content, Math.min(content.length, CONTENT_ECHO_LIMIT))
  const quoted = toDisplayJson(content.slice(0, end))
  return end === content.length ? quoted : `${quoted}${cutMarker(content.length - end)}`
}

interface EditBlockResult {
  id: string
  shortId: string
  /** The replacement with up to {@link EDIT_CONTEXT_CHARS} of context on each
   *  side, cuts marked: the confirmation, without echoing a long block whole. */
  excerpt: string
}

const EDIT_CONTEXT_CHARS = 200

const editExcerpt = (content: string, at: number, length: number): string => {
  const start = charBoundary(content, Math.max(0, at - EDIT_CONTEXT_CHARS))
  const end = charBoundary(content, Math.min(content.length, at + length + EDIT_CONTEXT_CHARS))
  return `${start > 0 ? cutMarker(start) : ''}${content.slice(start, end)}`
    + `${end < content.length ? cutMarker(content.length - end) : ''}`
}

export const editBlock = async (repo: Repo, input: EditBlockInput): Promise<EditBlockResult> => {
  const verb = 'edit-block'
  if (input.old === '') {
    throw new Error(`${verb}: old must not be empty — use update-block to replace the whole content.`)
  }
  const id = await blockIdField(repo, input.id, verb, input.exactIds)
  let excerpt = ''
  await repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block || block.deleted) throw new Error(`${verb}: block ${id} not found.`)
    assertActiveWorkspace(repo, verb, block.workspaceId)
    const at = block.content.indexOf(input.old)
    if (at < 0) {
      throw new Error(
        `${verb}: old text not found in block ${id}. Its current content is: ${contentEcho(block.content)}`,
      )
    }
    const count = occurrences(block.content, input.old)
    if (count > 1) {
      throw new Error(
        `${verb}: old text matches ${count} times in block ${id} — include more surrounding text so it matches once.`,
      )
    }
    // Spliced, not String.replace: a `$&` in the replacement stays literal.
    const content = block.content.slice(0, at) + input.new + block.content.slice(at + input.old.length)
    await tx.update(id, {content})
    excerpt = editExcerpt(content, at, input.new.length)
  }, agentTxOptions(verb))
  return {id, shortId: (await shortIds(repo, [id])).get(id)!, excerpt}
}

interface CreatePageInput {
  name?: string
  date?: string
}

export const createPage = async (
  repo: Repo,
  input: CreatePageInput,
): Promise<ResolvedAgentTarget & AppendedLine> => {
  const verb = 'create-page'
  if ((input.name === undefined) === (input.date === undefined)) {
    throw new Error(`${verb}: pass exactly one of name or date.`)
  }
  let resolved: ResolvedAgentTarget
  if (input.name !== undefined) {
    const name = createPageName(input.name)
    if (name === '') throw new Error(`${verb}: name is empty.`)
    resolved = await resolvePageTarget(repo, name, verb)
  } else {
    const date = parseRelativeDate(input.date!)
    if (!date) {
      throw new Error(
        `${verb}: Could not parse "${input.date}" as a date. Try today | yesterday | 2026-06-18 | "June 17th, 2026" | "next monday".`,
      )
    }
    resolved = await resolveDailyNoteTarget(repo, date.iso, verb)
  }
  const content = (await repo.load(resolved.id))?.content ?? ''
  const ids = await displayIds(repo, [resolved.id])
  return {...resolved, ...appendedLine(content, ids.get(resolved.id)!)}
}
