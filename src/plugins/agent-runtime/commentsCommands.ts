/**
 * The comment-thread verbs. `comments` reads the threads of a scope, of one
 * block, or one thread, each with its anchor resolved against the target as
 * it reads now and every comment with its author. `add-comment` starts a
 * thread. What a thread is, and every rule about it, lives in the annotations
 * plugin; this is its agent-facing shape.
 */

import {
  AGENT_VIEW_DEFAULTS,
  charBoundary,
  type CommentAuthor,
  type CommentNode,
  type CommentsView,
  type CommentThreadView,
} from '@knowledge-medium/agent-cli/protocol'
import type { BlockData } from '@/data/api'
import { hasBlockType } from '@/data/properties'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import type { Repo } from '@/data/repo'
import { addComment } from '@/plugins/annotations/addComment.js'
import { resolveAnchor } from '@/plugins/annotations/anchor.js'
import { THREAD_IDS_FOR_BLOCK_QUERY } from '@/plugins/annotations/queries.js'
import {
  annotationStatusProp, THREAD_TYPE, threadAnchorOf, threadIsOpen, threadStatusOf, threadTargetIdOf,
} from '@/plugins/annotations/schema.js'
import { threadIdsInScope } from '@/plugins/annotations/scope.js'
import { authorIdOf } from '@/plugins/contributors/author.js'
import { attributionCreatorsProp, contributorKindOf, type ContributorKind } from '@/plugins/contributors/schema.js'
import { agentTxOptions } from './agentWrites.ts'
import { loadBlocks, loadCrumbs } from './agentViews/context.ts'
import { shortIds } from './agentViews/resolveRef.ts'
import { clampInt, loadRoot } from './agentViews/shared.ts'
import { clip, clipLine, oneLine } from './agentViews/text.ts'

const MAX_THREAD_LIMIT = 100
/** Comments shown per thread, in reading order; `subtree` on the root reads
 *  the rest. */
const MAX_COMMENTS_PER_THREAD = 50
/** A quote past this is cut in the view; get_block on the root reads it. */
const QUOTE_MAX_CHARS = 1_000
/** Characters of target text kept on each side of a resolved quote. */
const EXCERPT_CONTEXT_CHARS = 80
const CONTRIBUTOR_KINDS: ReadonlySet<string> = new Set<ContributorKind>(['human', 'agent', 'automation'])

export interface CommentsParams {
  scope?: string
  block?: string
  thread?: string
  includeClosed?: boolean
  limit?: number
  offset?: number
}

const isThreadRoot = (row: BlockData | null | undefined): row is BlockData =>
  !!row && hasBlockType(row, THREAD_TYPE)

const statusOf = (root: BlockData): string => {
  try {
    return threadStatusOf(root)
  } catch {
    return String(root.properties[annotationStatusProp.name])
  }
}

const creatorsOf = (row: BlockData): readonly string[] => safeDecodeRowProperty(row, attributionCreatorsProp)

/** A profile's kind, or null when its stored kind is none this build knows. */
const kindOf = (page: BlockData): ContributorKind | null => {
  try {
    const kind = contributorKindOf(page)
    return CONTRIBUTOR_KINDS.has(kind) ? kind : null
  } catch {
    return null
  }
}

/** The thread roots a call names, newest first. */
const selectThreadIds = async (repo: Repo, workspaceId: string, params: CommentsParams): Promise<string[]> => {
  const named = (['scope', 'block', 'thread'] as const).filter(key => params[key] !== undefined)
  if (named.length !== 1) throw new Error('Pass exactly one of scope, block or thread.')
  const [key] = named
  // Refuses a missing or deleted block, and one in another workspace.
  const {root} = await loadRoot(repo, params[key]!, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  if (key === 'scope') return threadIdsInScope(repo, root.id)
  if (key === 'block') return repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId, id: root.id}).load()
  if (!hasBlockType(root, THREAD_TYPE)) throw new Error(`Block ${oneLine(root.id)} is not a comment thread's root.`)
  return [root.id]
}

/** The quote with some target text on each side; a long quote is cut in the
 *  middle of the excerpt, never the context around it. */
export const excerptOf = (content: string, range: {from: number; to: number} | null): string => {
  if (!range) return clipLine(content, EXCERPT_CONTEXT_CHARS * 2).text
  const from = charBoundary(content, Math.max(0, range.from - EXCERPT_CONTEXT_CHARS))
  const to = charBoundary(content, Math.min(content.length, range.to + EXCERPT_CONTEXT_CHARS))
  const quote = clip(content.slice(range.from, range.to), AGENT_VIEW_DEFAULTS.lineChars).text
  const window = `${content.slice(from, range.from)}${quote}${content.slice(range.to, to)}`
  return `${from > 0 ? '…' : ''}${oneLine(window)}${to < content.length ? '…' : ''}`
}

interface TargetRow {id: string; content: string; deleted: number}

const loadTargets = async (repo: Repo, ids: readonly string[]): Promise<Map<string, TargetRow>> => {
  const rows = ids.length === 0 ? [] : await repo.db.getAll<TargetRow>(
    'SELECT b.id, b.content, b.deleted FROM json_each(?) j CROSS JOIN blocks b ON b.id = j.value',
    [JSON.stringify([...new Set(ids)])],
  )
  return new Map(rows.map(row => [row.id, row]))
}

const authorsOf = async (repo: Repo, comments: readonly BlockData[]): Promise<Map<string, CommentAuthor>> => {
  const byComment = new Map<string, CommentAuthor>()
  const authorship = new Map(comments.map(comment => {
    const creators = creatorsOf(comment)
    return [comment.id, {pageId: authorIdOf({creators, ...comment}), byCreator: creators.length > 0}] as const
  }))
  const pageIds = [...new Set([...authorship.values()].flatMap(({pageId}) => pageId ?? []))]
  const pages = new Map((await loadBlocks(repo, pageIds)).map(page => [page.id, page]))
  for (const comment of comments) {
    const {pageId: id, byCreator} = authorship.get(comment.id)!
    const page = id ? pages.get(id) : null
    // A user's page may not exist yet, and a user's name is its id until it
    // does; a creator never falls back to `created_by`, the tab's human.
    const fallbackName = byCreator ? 'Contributor' : comment.createdBy
    byComment.set(comment.id, !id
      ? {id: null, name: 'System', kind: null}
      : page
        ? {id, name: page.content || fallbackName, kind: kindOf(page)}
        : {id, name: fallbackName, kind: byCreator ? null : 'human'})
  }
  return byComment
}

/** Each thread's visible descendants: its comments, at every depth. They
 *  stop at a nested thread root, as the scope read's descent does
 *  (annotations/scope.ts): a root moved by hand under one of these comments
 *  is its own thread, with its own comments. */
const commentRowsOf = async (repo: Repo, rootId: string): Promise<BlockData[]> => {
  const rows = await repo.query['core.subtree']({id: rootId, hidePropertyChildren: true}).load()
  const outside = new Set<string>()
  // Pre-order, so a row's parent is decided before the row.
  return rows.filter(row => {
    if (row.id === rootId) return false
    if ((row.parentId && outside.has(row.parentId)) || hasBlockType(row, THREAD_TYPE)) {
      outside.add(row.id)
      return false
    }
    return true
  })
}

export const buildCommentsView = async (
  repo: Repo,
  workspaceId: string,
  params: CommentsParams,
): Promise<CommentsView> => {
  const ids = await selectThreadIds(repo, workspaceId, params)
  const roots = (await loadBlocks(repo, ids, {workspaceId})).filter(isThreadRoot)
  // A thread asked for by its root is answered whatever its status.
  const listed = params.thread !== undefined || params.includeClosed ? roots : roots.filter(threadIsOpen)
  const offset = params.offset ?? 0
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.commentsLimit, MAX_THREAD_LIMIT)
  const page = listed.slice(offset, offset + limit)

  const commentRows = new Map(await Promise.all(page.map(async root => [root.id, await commentRowsOf(repo, root.id)] as const)))
  const allComments = [...commentRows.values()].flatMap(rows => rows.slice(0, MAX_COMMENTS_PER_THREAD))
  const targetIds = page.flatMap(root => threadTargetIdOf(root) ?? [])
  const [targets, authors, crumbs, short] = await Promise.all([
    loadTargets(repo, targetIds),
    authorsOf(repo, allComments),
    loadCrumbs(repo, targetIds, workspaceId),
    shortIds(repo, [...page.map(root => root.id), ...targetIds, ...allComments.map(row => row.id)]),
  ])

  const threadView = (root: BlockData): CommentThreadView => {
    const anchor = threadAnchorOf(root)
    const targetId = threadTargetIdOf(root)
    const target = targetId ? targets.get(targetId) : undefined
    const resolution = anchor.kind === 'range' && target ? resolveAnchor(target.content, anchor) : null
    const range = resolution && resolution.state !== 'stale' ? resolution : null

    const nodes = new Map<string, CommentNode>()
    const topLevel: CommentNode[] = []
    const rows = commentRows.get(root.id) ?? []
    // Pre-order, so the kept prefix is a whole tree: no reply without its parent.
    for (const row of rows.slice(0, MAX_COMMENTS_PER_THREAD)) {
      const {text: content, cut} = clip(row.content, AGENT_VIEW_DEFAULTS.blockMaxChars)
      const node: CommentNode = {
        id: row.id,
        shortId: short.get(row.id) ?? row.id,
        content,
        cut,
        author: authors.get(row.id)!,
        createdAt: row.createdAt,
        replies: [],
      }
      nodes.set(row.id, node)
      const parent = row.parentId ? nodes.get(row.parentId) : undefined
      if (parent) parent.replies.push(node)
      else topLevel.push(node)
    }

    return {
      id: root.id,
      shortId: short.get(root.id) ?? root.id,
      status: statusOf(root),
      anchor: anchor.kind === 'block' ? 'block' : resolution?.state ?? 'stale',
      quote: anchor.kind === 'block' ? null : clip(anchor.quote, QUOTE_MAX_CHARS).text,
      target: targetId ? {
        id: targetId,
        shortId: short.get(targetId) ?? targetId,
        deleted: target?.deleted === 1,
        path: crumbs.get(targetId) ?? [],
        excerpt: target ? excerptOf(target.content, range) : '',
      } : null,
      comments: topLevel,
      omittedComments: Math.max(0, rows.length - MAX_COMMENTS_PER_THREAD),
    }
  }

  // The page ends early once its JSON passes the views' budget; the first
  // thread is always shown, so paging advances.
  const threads: CommentThreadView[] = []
  let chars = 0
  for (const root of page) {
    const view = threadView(root)
    chars += JSON.stringify(view).length
    if (threads.length > 0 && chars > AGENT_VIEW_DEFAULTS.outlineChars) break
    threads.push(view)
  }
  const shownTo = offset + threads.length
  return {total: listed.length, offset, nextOffset: shownTo < listed.length ? shownTo : null, threads}
}

export interface AddCommentParams {
  /** The annotated block's full id. */
  targetId: string
  quote?: string
  occurrence?: number
  content?: string
}

export interface AddedComment {
  threadId: string
  commentId: string | null
  /** What the thread stores: a quote that cut a reference is widened to it. */
  quote: string | null
  /** Where the quote starts in the block's content, and the text around it,
   *  so the caller can check it anchored the appearance it meant. */
  quoteStart: number | null
  excerpt: string | null
}

export const runAddComment = async (
  repo: Repo,
  {targetId, quote, occurrence, content}: AddCommentParams,
): Promise<AddedComment> => {
  const created = await addComment(repo, {targetId, quote, occurrence, comment: content}, {
    description: agentTxOptions('add-comment').description,
  })
  const [root, target] = await loadBlocks(repo, [created.threadId, targetId])
  const anchor = root ? threadAnchorOf(root) : null
  const quoteStart = anchor?.kind === 'range' ? anchor.quoteStart ?? null : null
  return {
    ...created,
    quote: anchor?.kind === 'range' ? anchor.quote : null,
    quoteStart,
    excerpt: anchor?.kind === 'range' && quoteStart !== null && target
      ? excerptOf(target.content, {from: quoteStart, to: quoteStart + anchor.quote.length})
      : null,
  }
}
