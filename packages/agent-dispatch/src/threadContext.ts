/**
 * What a mention inside a comment thread adds to its prompt: the annotated
 * block, the quote, the block's page path, and the chain of comments from the
 * thread's first one down to the mention, each with its author. A chain
 * rather than the whole thread keeps the prompt bounded on a long thread; the
 * run can read the rest with the comments tool.
 */
import {
  AGENT_VIEW_DEFAULTS,
  clip,
  COMMENT_THREAD_TYPE,
  type CommentAuthor,
  type CommentNode,
} from '@knowledge-medium/agent-cli/protocol'
import type { BlockData, Graph } from './graph.js'
import type { ThreadPromptContext } from './prompt.js'

const isThreadRoot = (block: BlockData): boolean => {
  const types = block.properties?.types
  return Array.isArray(types) && types.includes(COMMENT_THREAD_TYPE)
}

const authorsById = (comments: readonly CommentNode[], into = new Map<string, CommentAuthor>()): Map<string, CommentAuthor> => {
  for (const comment of comments) {
    into.set(comment.id, comment.author)
    authorsById(comment.replies, into)
  }
  return into
}

const bounded = (text: string | undefined): string => clip(text ?? '', AGENT_VIEW_DEFAULTS.blockMaxChars).text

/** The thread context for `source`, a mention whose ancestors (nearest first)
 *  are `ancestors`, or null outside a thread. The chain's text comes from
 *  those ancestors, so it reaches the mention however the thread view is cut;
 *  the view gives the authors. Throws when the thread can't be read. */
export const loadThreadContext = async (
  graph: Pick<Graph, 'comments' | 'getBlock'>,
  source: BlockData,
  ancestors: readonly BlockData[],
): Promise<ThreadPromptContext | null> => {
  const rootIndex = ancestors.findIndex(isThreadRoot)
  if (rootIndex < 0) return null
  const [thread] = (await graph.comments({thread: ancestors[rootIndex].id})).threads
  if (!thread) return null
  const target = thread.target ? await graph.getBlock(thread.target.id) : null
  const authors = authorsById(thread.comments)
  return {
    target: target && thread.target ? {content: bounded(target.content), path: thread.target.path} : null,
    quote: thread.quote,
    anchor: thread.anchor,
    chain: [...ancestors.slice(0, rootIndex).reverse(), source].map(block => ({
      id: block.id,
      content: bounded(block.content),
      author: authors.get(block.id) ?? null,
    })),
  }
}
