/**
 * Markdown-native, conflict-safe agent writes: `append-markdown`,
 * `edit-block`, `create-page`. Each refuses inside its writing transaction
 * against the rows current there, so an edit made on another device since the
 * agent read is never clobbered.
 */
import type { BlockData } from '@/data/api'
import { createChild, type InsertPosition } from '@/data/mutators.js'
import type { Repo } from '@/data/repo'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser.js'
import { parseRelativeDate } from '@/utils/relativeDate.js'
import { agentTxOptions } from './agentWrites.ts'
import {
  resolveAgentTarget,
  resolveBlockId,
  resolveDailyNoteTarget,
  resolvePageTarget,
  type ResolvedAgentTarget,
} from './targets.ts'
import { assertActiveWorkspace } from './workspaceGuard.ts'

export type MarkdownShape = 'outline' | 'block'

/** Markdown → blocks to create: the app paste parser's split for `'outline'`
 *  (the default), or the whole text as ONE block for `'block'`. */
export const parseAgentMarkdown = (markdown: string, shape: MarkdownShape = 'outline'): ParsedBlock[] =>
  shape === 'block'
    ? (markdown.length === 0 ? [] : [{id: 'block-root', orderKey: '', content: markdown}])
    : parseMarkdownToBlocks(markdown)

export interface AppendMarkdownInput {
  target: string
  markdown: string
  position?: InsertPosition
  shape?: MarkdownShape
}

export interface AppendedBlock {
  id: string
  parentId: string
  /** 0 for a direct child of the target. */
  depth: number
  content: string
}

export interface AppendMarkdownResult {
  target: ResolvedAgentTarget & {content: string}
  /** Created blocks in pre-order. */
  blocks: AppendedBlock[]
}

const siblingPosition = async (
  repo: Repo,
  verb: string,
  position: InsertPosition | undefined,
): Promise<InsertPosition> => {
  if (position === undefined) return {kind: 'last'}
  if (position.kind === 'first' || position.kind === 'last') return position
  return {kind: position.kind, siblingId: await resolveBlockId(repo, position.siblingId, verb)}
}

export const appendMarkdown = async (
  outerRepo: Repo,
  input: AppendMarkdownInput,
): Promise<AppendMarkdownResult> => {
  const verb = 'append-markdown'
  // Before resolving the target: resolution can CREATE a page.
  if (input.markdown.trim() === '') throw new Error(`${verb}: markdown is empty — nothing to append.`)
  const parsed = parseAgentMarkdown(input.markdown, input.shape)

  // A created page / daily note commits in its own tx; one undo entry for both.
  return outerRepo.undoGroup(async repo => {
    const target = await resolveAgentTarget(repo, input.target, {verb, create: true})
    const firstPosition = await siblingPosition(repo, verb, input.position)
    const blocks: AppendedBlock[] = []
    let targetContent = ''

    await repo.tx(async tx => {
      // A missing or deleted target is refused by `createChild` itself.
      const row = await tx.get(target.id)
      if (row) assertActiveWorkspace(repo, verb, row.workspaceId)
      targetContent = row?.content ?? ''
      const created = new Map<string, {id: string; depth: number}>()
      let previousRootId: string | null = null
      for (const node of parsed) {
        const parent = node.parentId ? created.get(node.parentId)! : null
        const parentId = parent?.id ?? target.id
        // Each root lands right after the previous one, so the run stays in
        // document order wherever the first one went.
        const position: InsertPosition = parent
          ? {kind: 'last'}
          : previousRootId ? {kind: 'after', siblingId: previousRootId} : firstPosition
        const id: string = await tx.run(createChild, {parentId, content: node.content, position})
        const depth = parent ? parent.depth + 1 : 0
        created.set(node.id, {id, depth})
        if (!parent) previousRootId = id
        blocks.push({id, parentId, depth, content: node.content})
      }
    }, agentTxOptions(verb))

    return {target: {...target, content: targetContent}, blocks}
  })
}

export interface EditBlockInput {
  id: string
  old: string
  new: string
}

/** Overlapping occurrences — `aa` occurs twice in `aaa`, which is ambiguous to
 *  replace. Bounded by the text length, so an empty needle cannot spin. */
const occurrences = (text: string, needle: string): number => {
  let count = 0
  for (let at = text.indexOf(needle); at >= 0 && at < text.length; at = text.indexOf(needle, at + 1)) count += 1
  return count
}

const CONTENT_ECHO_LIMIT = 1000

/** The block's content as an error shows it — enough for the agent to re-plan
 *  without another read. */
export const contentEcho = (content: string): string =>
  content.length > CONTENT_ECHO_LIMIT
    ? `${content.slice(0, CONTENT_ECHO_LIMIT)}… (${content.length} chars; read the block for the rest)`
    : content

export const editBlock = async (repo: Repo, input: EditBlockInput): Promise<BlockData | null> => {
  const verb = 'edit-block'
  if (input.old === '') {
    throw new Error(`${verb}: old must not be empty — use update-block to replace the whole content.`)
  }
  const id = await resolveBlockId(repo, input.id, verb)
  await repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block || block.deleted) throw new Error(`${verb}: block ${id} not found.`)
    assertActiveWorkspace(repo, verb, block.workspaceId)
    const at = block.content.indexOf(input.old)
    if (at < 0) {
      throw new Error(
        `${verb}: old text not found in block ${id}. Its current content is:\n${contentEcho(block.content)}`,
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
  }, agentTxOptions(verb))
  return repo.load(id)
}

export interface CreatePageInput {
  name?: string
  date?: string
}

export const createPage = async (
  repo: Repo,
  input: CreatePageInput,
): Promise<ResolvedAgentTarget & {content: string}> => {
  const verb = 'create-page'
  if ((input.name === undefined) === (input.date === undefined)) {
    throw new Error(`${verb}: pass exactly one of name or date.`)
  }
  const options = {verb, create: true}
  let resolved: ResolvedAgentTarget
  if (input.name !== undefined) {
    const name = input.name.trim().replace(/^\[\[(.*)\]\]$/s, '$1').trim()
    if (name === '') throw new Error(`${verb}: name is empty.`)
    resolved = await resolvePageTarget(repo, name, options)
  } else {
    const date = parseRelativeDate(input.date!)
    if (!date) {
      throw new Error(
        `${verb}: Could not parse "${input.date}" as a date. Try today | yesterday | 2026-06-18 | "June 17th, 2026" | "next monday".`,
      )
    }
    resolved = await resolveDailyNoteTarget(repo, date.iso, options)
  }
  return {...resolved, content: (await repo.load(resolved.id))?.content ?? ''}
}
