/*
 * Prompt assembly for spawned agent runs. Small `{{placeholder}}`
 * templating — deliberately not a template engine.
 */

import { neutralizeDisplayText, type CommentAnchorState, type CommentAuthor } from '@knowledge-medium/agent-cli/protocol'
import { renderSubtreeOutline } from '@knowledge-medium/agent-cli/subtreeOutline'

/** A mention inside a comment thread (threadContext.ts). */
export interface ThreadPromptContext {
  /** The annotated block; null when it is gone. */
  target: {content: string, path: string[]} | null
  /** The quoted text; null for a thread on the whole block. */
  quote: string | null
  anchor: CommentAnchorState
  /** The text an edit suggestion would put in place of the quote; null for a
   *  thread that suggests nothing. */
  replacement: string | null
  /** From the thread's first comment down to the one that mentioned you;
   *  `author` is null for a comment the thread view left out. */
  chain: Array<{id: string, content: string, author: CommentAuthor | null}>
}

export interface MentionPromptContext {
  /** The mention block's own content. */
  content: string
  /** Rendered outline of the mention block's subtree. */
  subtree: string
  /** Path from the root to the block, nearest last. */
  ancestors: Array<{id: string, content: string}>
  blockId: string
  deepLink: string
  watcherName: string
  /** The watched page alias, as the user types it inside `[[…]]`. */
  target: string
  /** Present when the mention is a comment in a thread. */
  thread?: ThreadPromptContext
  /** The daemon will split this reply into a block hierarchy along its
   *  markdown outline — append the outline-authoring nudge so the split
   *  threads naturally (the "prompting" half of the feature). */
  splitReply?: boolean
}

/** Only a full UUID in one of these forms parses as a block reference; the
 *  ^shortids the km tools print are display text. */
const BLOCK_LINK_RULE = 'write [a few words](((full block id))) to link a block, with the id in full as get_block prints it in parentheses (a ^shortid is how the tools print an id, not a link)'

export const DEFAULT_MENTION_PROMPT = `You were mentioned as [[{{target}}]] in the user's Knowledge Medium notes, an outliner where blocks nest under blocks. Read the mention as a request addressed to you.

The block that mentioned you (id {{blockId}}):
{{content}}
{{thread}}
Its full subtree (the request often continues in its children):
{{subtree}}

Path from the page root to that block (nearest last):
{{ancestors}}

How to work:
- Read what the request leans on with the km tools (the pages it links, the page around it) instead of guessing at it.
- Your final message is posted for you as the reply under the mention. Don't also post it with a write tool, or it appears twice.
- Change the notes only when the request asks you to, and say in the reply what you changed. Add new material with append_markdown under the block it belongs to. To change text the user wrote, propose the edit with add_comment (a quote plus its replacement) for them to accept or reject; edit it yourself (edit_block) only when the request plainly asks you to make the change.
- If the request is ambiguous, ask one short question in the reply instead of guessing: a mention of [[{{target}}]] under your reply continues this conversation.
- Cite what you used: link web sources, write [[Page name]] for a page, and ${BLOCK_LINK_RULE}.
- Never write [[{{target}}]], or another watched page, into the notes: it would start another run, so the write is refused.

Reply in concise, notes-style markdown, with no preamble.`

/** Appended to a mention prompt when the watcher has `splitReply` on: the
 *  daemon splits the reply along its markdown outline into a block
 *  hierarchy, so nudge the run to WRITE a nested outline. Each top-level
 *  line/bullet becomes its own block and indented bullets become child
 *  blocks; prose paragraphs stay whole. */
export const SPLIT_REPLY_GUIDANCE = `

Your reply will be split into a block hierarchy along its markdown outline: each top-level line or bullet becomes its own block, and nested (indented) bullets become child blocks (headings nest their following content too; fenced code stays whole). So structure the answer as a nested bullet outline — one idea per bullet, indentation for sub-points — rather than one dense paragraph. Multi-sentence prose you want kept together should stay in a single paragraph (no blank line inside it).`

export const DEFAULT_QUERY_PROMPT = `A watched query over the user's Knowledge Medium notes returned new rows.

Watcher: {{watcherName}}

New rows (JSON):
{{newRows}}

Use the km MCP tools to inspect the referenced blocks if needed, then act per the watcher's intent.`

/** Channel-delivery variant: the ambient session must close the task
 *  lifecycle itself (the daemon only claims and delivers). */
export const DEFAULT_MENTION_CHANNEL_PROMPT = `New mention in the user's Knowledge Medium notes (watcher: {{watcherName}}).

The block that mentioned you (id {{blockId}}):
{{content}}
{{thread}}
Its full subtree:
{{subtree}}

Path from the page root (nearest last):
{{ancestors}}

Handle it now, then close the task out yourself:
1. Do the work with the km tools.
2. Post your answer with create_block: parentId {{blockId}}, your reply as content, and properties {"agent:reply": true}. In it, ${BLOCK_LINK_RULE}.
3. Mark the task finished with update_block on {{blockId}}: properties {"agent:status": "done"} (or "error" plus {"agent:error": "<why>"} if you could not complete it).
Never write [[{{target}}]], or another watched page, anywhere: it would start another run, so the write is refused.`

const ANCHOR_NOTES: Partial<Record<CommentAnchorState, string>> = {
  moved: ' (it has moved within the block since)',
  stale: ' (no longer in the block as quoted)',
}

const authorLabel = (author: CommentAuthor | null): string =>
  !author ? '(author not shown)' : author.kind ? `${author.name} (${author.kind})` : author.name

const renderThreadContext = (thread: ThreadPromptContext): string => {
  const lines = ['The block that mentioned you is a comment in a thread on another block.', '']
  if (thread.target) {
    const path = thread.target.path.length > 0 ? thread.target.path.join(' › ') : '(top level)'
    lines.push(`The annotated block (page path: ${path}):`, thread.target.content, '')
  } else {
    lines.push('The annotated block has been deleted.', '')
  }
  lines.push(thread.quote === null
    ? 'The thread is on the whole block.'
    : `The thread quotes: "${neutralizeDisplayText(thread.quote)}"${ANCHOR_NOTES[thread.anchor] ?? ''}`)
  if (thread.replacement !== null) {
    lines.push(
      `It is an edit suggestion to replace that text with: "${neutralizeDisplayText(thread.replacement)}"`,
      'A person accepts or rejects it in the app.',
    )
  }
  lines.push('')
  // One line per comment, as the subtree outline renders: a comment's text
  // can't forge another comment or its author.
  lines.push('The thread, from its first comment down to the one that mentioned you:', renderSubtreeOutline(
    thread.chain.map((comment, depth) => ({
      id: comment.id, parentId: null, depth, content: `${authorLabel(comment.author)}: ${comment.content}`,
    })),
  ))
  return lines.join('\n')
}

const THREAD_PLACEHOLDER = '{{thread}}'

const renderTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match)

export const renderMentionPrompt = (
  template: string | undefined,
  context: MentionPromptContext,
): string => {
  const chosen = template ?? DEFAULT_MENTION_PROMPT
  const thread = context.thread ? renderThreadContext(context.thread) : ''
  const rendered = renderTemplate(chosen, {
    // Blank-line framed in place, so an empty one leaves the template as it was.
    thread: thread ? `\n${thread}\n` : '',
    content: context.content,
    subtree: context.subtree,
    ancestors: context.ancestors.length > 0
      ? renderSubtreeOutline(context.ancestors.map(ancestor => ({...ancestor, parentId: null, depth: 0})))
      : '(top level)',
    blockId: context.blockId,
    deepLink: context.deepLink,
    watcherName: context.watcherName,
    target: context.target,
  })
  // A custom `prompt` that doesn't place the thread still gets it, after.
  const withThread = thread && !chosen.includes(THREAD_PLACEHOLDER) ? `${rendered}\n\n${thread}` : rendered
  // The nudge rides on the RENDERED prompt (not the template) so it also
  // applies to a watcher's custom `prompt` — splitReply is orthogonal to
  // what the run is asked to do.
  return context.splitReply ? `${withThread}${SPLIT_REPLY_GUIDANCE}` : withThread
}

export interface QueryPromptContext {
  newRows: unknown[]
  watcherName: string
}

export const renderQueryPrompt = (
  template: string | undefined,
  context: QueryPromptContext,
): string =>
  renderTemplate(template ?? DEFAULT_QUERY_PROMPT, {
    newRows: JSON.stringify(context.newRows, null, 2),
    watcherName: context.watcherName,
  })
