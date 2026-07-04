/**
 * Prompt assembly for spawned agent runs. Small `{{placeholder}}`
 * templating — deliberately not a template engine.
 */

export interface MentionPromptContext {
  /** The mention block's own content. */
  content: string
  /** Rendered outline of the mention block's subtree. */
  subtree: string
  /** Ancestor contents, nearest last (path from root to the block). */
  ancestors: string[]
  blockId: string
  deepLink: string
  watcherName: string
  /** The daemon will split this reply into a block hierarchy along its
   *  markdown outline — append the outline-authoring nudge so the split
   *  threads naturally (the "prompting" half of the feature). */
  splitReply?: boolean
}

export const DEFAULT_MENTION_PROMPT = `You are responding to a mention inside the user's Knowledge Medium notes (an outliner: blocks nest under blocks).

The block that mentioned you:
{{content}}

Its full subtree (the task usually lives here):
{{subtree}}

Path from the page root to that block (context, nearest last):
{{ancestors}}

Block id: {{blockId}}

Instructions:
- Read the mention as a request addressed to you. If the subtree contains sub-items, treat them as part of the request.
- Use the km MCP tools when you need more of the graph (search, get_block, subtree, backlinks) or to make edits (create_block, update_block, move_block, delete_block, restore_block).
- Your final text response is posted verbatim as a reply block under the mention. Keep it concise, notes-style markdown. No preamble.
- Never write the literal token [[claude]] (or any watcher-target wikilink) into the graph or your reply — it would re-trigger the watcher.`

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

Its full subtree:
{{subtree}}

Path from the page root (nearest last):
{{ancestors}}

Handle it now, then close the task out yourself:
1. Do the work, using the km tools (search, get_block, subtree, backlinks; create_block/update_block/move_block/delete_block/restore_block for edits).
2. Post your answer with create_block: parentId {{blockId}}, your reply as content, and properties {"agent:reply": true}.
3. Mark the task finished with update_block on {{blockId}}: properties {"agent:status": "done"} (or "error" plus {"agent:error": "<why>"} if you could not complete it).
Never write the literal token [[claude]] (or any watcher-target wikilink) anywhere — it re-triggers the watcher.`

const renderTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match)

export const renderMentionPrompt = (
  template: string | undefined,
  context: MentionPromptContext,
): string => {
  const rendered = renderTemplate(template ?? DEFAULT_MENTION_PROMPT, {
    content: context.content,
    subtree: context.subtree,
    ancestors: context.ancestors.length > 0 ? context.ancestors.map(line => `- ${line}`).join('\n') : '(top level)',
    blockId: context.blockId,
    deepLink: context.deepLink,
    watcherName: context.watcherName,
  })
  // The nudge rides on the RENDERED prompt (not the template) so it also
  // applies to a watcher's custom `prompt` — splitReply is orthogonal to
  // what the run is asked to do.
  return context.splitReply ? `${rendered}${SPLIT_REPLY_GUIDANCE}` : rendered
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
