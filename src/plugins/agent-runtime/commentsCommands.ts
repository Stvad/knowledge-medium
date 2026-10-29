/**
 * The comment-thread verbs. `comments` reads the threads of a scope, of one
 * block, or one thread, each with its anchor resolved against the target as
 * it reads now and every comment with its author. `add-comment` starts a
 * thread. What a thread is, and every rule about it, lives in the annotations
 * plugin; this is its agent-facing shape.
 */

import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import type { BlockData } from '@/data/api'
import { hasBlockType } from '@/data/properties'
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
import { loadCrumbs } from './agentViews/context.ts'
import { resolveBlockRef, shortIds } from './agentViews/resolveRef.ts'
import { clampInt } from './agentViews/shared.ts'
import { clipLine, oneLine } from './agentViews/text.ts'

const DEFAULT_THREAD_LIMIT = 20
const MAX_THREAD_LIMIT = 100
/** Characters of target text kept on each side of a resolved quote. */
const EXCERPT_CONTEXT_CHARS = 80

export type AnchorState = 'block' | 'exact' | 'moved' | 'stale'

export interface CommentAuthor {
  /** The author's page; null for a system author. */
  id: string | null
  name: string
  /** Null when the author's page is not here to say. */
  kind: ContributorKind | null
}

export interface CommentNode {
  id: string
  shortId: string
  content: string
  /** Characters cut from `content`; get_block reads the rest. */
  cut: number
  author: CommentAuthor
  createdAt: number
  replies: CommentNode[]
}

export interface ThreadView {
  id: string
  shortId: string
  /** `open` or `resolved`, or the stored value when this build can't read it. */
  status: string
  anchor: AnchorState
  /** The quoted text; null for a thread on the whole block. */
  quote: string | null
  target: {
    id: string
    shortId: string
    deleted: boolean
    /** Root→parent labels, as a breadcrumb reads. */
    path: string[]
    /** The quote with some text around it, or the block's head. */
    excerpt: string
  } | null
  comments: CommentNode[]
}

export interface CommentsView {
  total: number
  offset: number
  nextOffset: number | null
  threads: ThreadView[]
}

export interface CommentsParams {
  scope?: string
  block?: string
  thread?: string
  includeClosed?: boolean
  limit?: number
  offset?: number
}

const isThreadRoot = (row: BlockData | null | undefined): row is BlockData =>
  !!row && !row.deleted && hasBlockType(row, THREAD_TYPE)

const statusOf = (root: BlockData): string => {
  try {
    return threadStatusOf(root)
  } catch {
    return String(root.properties[annotationStatusProp.name])
  }
}

const creatorsOf = (row: BlockData): readonly string[] => {
  try {
    return attributionCreatorsProp.codec.decode(row.properties[attributionCreatorsProp.name] ?? [])
  } catch {
    return []
  }
}

/** The thread roots a call names, newest first. */
const selectThreadIds = async (repo: Repo, workspaceId: string, params: CommentsParams): Promise<string[]> => {
  const named = (['scope', 'block', 'thread'] as const).filter(key => params[key] !== undefined)
  if (named.length !== 1) throw new Error('Pass exactly one of scope, block or thread.')
  const [key] = named
  const {id} = await resolveBlockRef(repo, params[key]!, {workspaceId})
  if (key === 'scope') return threadIdsInScope(repo, id)
  if (key === 'block') return repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId, id}).load()
  if (!isThreadRoot(await repo.load(id))) {
    throw new Error(`Block ${oneLine(id)} is not a comment thread's root.`)
  }
  return [id]
}

const excerptOf = (content: string, range: {from: number; to: number} | null): string => {
  if (!range) return clipLine(content, EXCERPT_CONTEXT_CHARS * 2).text
  const from = Math.max(0, range.from - EXCERPT_CONTEXT_CHARS)
  const to = Math.min(content.length, range.to + EXCERPT_CONTEXT_CHARS)
  return `${from > 0 ? '…' : ''}${oneLine(content.slice(from, to))}${to < content.length ? '…' : ''}`
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
  const pageIds = new Map<string, string | undefined>()
  for (const comment of comments) {
    pageIds.set(comment.id, authorIdOf({creators: creatorsOf(comment), ...comment}))
  }
  const pages = new Map<string, BlockData | null>()
  for (const id of new Set(pageIds.values())) {
    if (id) pages.set(id, await repo.load(id) ?? null)
  }
  for (const comment of comments) {
    const id = pageIds.get(comment.id)
    const page = id ? pages.get(id) : null
    // A user's page may not exist yet, and a user's name is its id until it
    // does; a creator never falls back to `created_by`, the tab's human.
    const byCreator = creatorsOf(comment).length > 0
    const fallbackName = byCreator ? 'Contributor' : comment.createdBy
    byComment.set(comment.id, !id
      ? {id: null, name: 'System', kind: null}
      : page
        ? {id, name: page.content || fallbackName, kind: contributorKindOf(page)}
        : {id, name: fallbackName, kind: byCreator ? null : 'human'})
  }
  return byComment
}

/** Each thread's visible descendants: its comments, at every depth. */
const commentRowsOf = async (repo: Repo, rootId: string): Promise<BlockData[]> =>
  (await repo.query['core.subtree']({id: rootId, hidePropertyChildren: true}).load())
    .filter(row => row.id !== rootId)

export const buildCommentsView = async (
  repo: Repo,
  workspaceId: string,
  params: CommentsParams,
): Promise<CommentsView> => {
  const ids = await selectThreadIds(repo, workspaceId, params)
  const roots = (await Promise.all(ids.map(id => repo.load(id)))).filter(isThreadRoot)
  // A thread asked for by its root is answered whatever its status.
  const listed = params.thread !== undefined || params.includeClosed ? roots : roots.filter(threadIsOpen)
  const offset = params.offset ?? 0
  const limit = clampInt(params.limit, DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT)
  const page = listed.slice(offset, offset + limit)

  const commentRows = new Map(await Promise.all(page.map(async root => [root.id, await commentRowsOf(repo, root.id)] as const)))
  const allComments = [...commentRows.values()].flat()
  const targetIds = page.flatMap(root => threadTargetIdOf(root) ?? [])
  const [targets, authors, crumbs, short] = await Promise.all([
    loadTargets(repo, targetIds),
    authorsOf(repo, allComments),
    loadCrumbs(repo, targetIds, workspaceId),
    shortIds(repo, [...page.map(root => root.id), ...targetIds, ...allComments.map(row => row.id)]),
  ])

  const threadView = (root: BlockData): ThreadView => {
    const anchor = threadAnchorOf(root)
    const targetId = threadTargetIdOf(root)
    const target = targetId ? targets.get(targetId) : undefined
    const resolution = anchor.kind === 'range' && target ? resolveAnchor(target.content, anchor) : null
    const range = resolution && resolution.state !== 'stale' ? resolution : null

    const nodes = new Map<string, CommentNode>()
    const topLevel: CommentNode[] = []
    for (const row of commentRows.get(root.id) ?? []) {
      const cut = Math.max(0, row.content.length - AGENT_VIEW_DEFAULTS.blockMaxChars)
      const node: CommentNode = {
        id: row.id,
        shortId: short.get(row.id) ?? row.id,
        content: cut > 0 ? `${row.content.slice(0, AGENT_VIEW_DEFAULTS.blockMaxChars)}…` : row.content,
        cut,
        author: authors.get(row.id)!,
        createdAt: row.createdAt,
        replies: [],
      }
      nodes.set(row.id, node)
      // Pre-order, so a parent is always placed before its children.
      const parent = row.parentId ? nodes.get(row.parentId) : undefined
      if (parent) parent.replies.push(node)
      else topLevel.push(node)
    }

    return {
      id: root.id,
      shortId: short.get(root.id) ?? root.id,
      status: statusOf(root),
      anchor: anchor.kind === 'block' ? 'block' : resolution?.state ?? 'stale',
      quote: anchor.kind === 'block' ? null : anchor.quote,
      target: targetId ? {
        id: targetId,
        shortId: short.get(targetId) ?? targetId,
        deleted: !target || target.deleted === 1,
        path: crumbs.get(targetId) ?? [],
        excerpt: target ? excerptOf(target.content, range) : '',
      } : null,
      comments: topLevel,
    }
  }

  const nextOffset = offset + page.length < listed.length ? offset + page.length : null
  return {total: listed.length, offset, nextOffset, threads: page.map(threadView)}
}

export interface AddCommentParams {
  /** The annotated block's full id. */
  targetId: string
  quote?: string
  occurrence?: number
  content?: string
}

/** `quote` is what the thread stores, which a quote cutting a reference
 *  widens to the whole reference. */
export const runAddComment = async (
  repo: Repo,
  {targetId, quote, occurrence, content}: AddCommentParams,
): Promise<{threadId: string, commentId: string | null, quote: string | null}> => {
  const created = await addComment(repo, {targetId, quote, occurrence, comment: content}, {
    description: agentTxOptions('add-comment').description,
  })
  const root = await repo.load(created.threadId)
  return {...created, quote: root?.content || null}
}
