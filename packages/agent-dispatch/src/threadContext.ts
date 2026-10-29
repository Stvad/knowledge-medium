/**
 * What a mention inside a comment thread adds to its prompt: the annotated
 * block, the quote, the block's page path, and the chain of comments from the
 * thread's first one down to the mention, each with its author. A chain
 * rather than the whole thread keeps the prompt bounded on a long thread; the
 * run can read the rest with the comments tool.
 */
import { COMMENT_THREAD_TYPE, type CommentNode, type CommentThreadView } from '@knowledge-medium/agent-cli/protocol'
import type { BlockData, Graph } from './graph.js'
import type { ThreadPromptContext } from './prompt.js'

const isThreadRoot = (block: BlockData): boolean => {
  const types = block.properties?.types
  return Array.isArray(types) && types.includes(COMMENT_THREAD_TYPE)
}

/** The thread `sourceId` sits in, from its ancestors (nearest first): the
 *  root, and the ids from the root's child down to the source. Null outside
 *  a thread. */
export const threadPathOf = (
  sourceId: string,
  ancestors: readonly BlockData[],
): {rootId: string, chainIds: string[]} | null => {
  const index = ancestors.findIndex(isThreadRoot)
  if (index < 0) return null
  return {
    rootId: ancestors[index].id,
    chainIds: [...ancestors.slice(0, index).map(block => block.id).reverse(), sourceId],
  }
}

/** The comments along `chainIds`, as far as the thread's tree has them. */
const chainOf = (comments: readonly CommentNode[], chainIds: readonly string[]): CommentNode[] => {
  const chain: CommentNode[] = []
  let level = comments
  for (const id of chainIds) {
    const node = level.find(comment => comment.id === id)
    if (!node) break
    chain.push(node)
    level = node.replies
  }
  return chain
}

/** The prompt context for a mention at the end of `path`, or null when the
 *  thread can't be read (an app tab without the comments verb, or the
 *  plugin off): the mention is still answered, without it. */
export const loadThreadContext = async (
  graph: Pick<Graph, 'comments' | 'getBlock'>,
  path: {rootId: string, chainIds: string[]},
): Promise<ThreadPromptContext | null> => {
  const view = await graph.comments({thread: path.rootId})
  const thread: CommentThreadView | undefined = view.threads[0]
  if (!thread) return null
  const target = thread.target ? await graph.getBlock(thread.target.id) : null
  return {
    target: target ? {content: target.content ?? '', path: thread.target?.path ?? []} : null,
    quote: thread.quote,
    anchor: thread.anchor,
    chain: chainOf(thread.comments, path.chainIds).map(comment => ({
      author: comment.author.name,
      kind: comment.author.kind,
      content: comment.content,
    })),
  }
}
