/**
 * Prompt assembly for spawned Claude runs. Small `{{placeholder}}`
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
- Use the km MCP tools when you need more of the graph (search, get_block, subtree, backlinks) or to make edits (create_block, update_block).
- Your final text response is posted verbatim as a reply block under the mention. Keep it concise, notes-style markdown. No preamble.
- Never write the literal token [[claude]] (or any watcher-target wikilink) into the graph or your reply — it would re-trigger the watcher.`

export const DEFAULT_QUERY_PROMPT = `A watched query over the user's Knowledge Medium notes returned new rows.

Watcher: {{watcherName}}

New rows (JSON):
{{newRows}}

Use the km MCP tools to inspect the referenced blocks if needed, then act per the watcher's intent.`

const renderTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match)

export const renderMentionPrompt = (
  template: string | undefined,
  context: MentionPromptContext,
): string =>
  renderTemplate(template ?? DEFAULT_MENTION_PROMPT, {
    content: context.content,
    subtree: context.subtree,
    ancestors: context.ancestors.length > 0 ? context.ancestors.map(line => `- ${line}`).join('\n') : '(top level)',
    blockId: context.blockId,
    deepLink: context.deepLink,
    watcherName: context.watcherName,
  })

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
