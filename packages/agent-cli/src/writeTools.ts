/* The rendering of an append result, shared by the km MCP tool and the CLI
 * verb. Lives apart from `cli.ts` because that module self-executes on import. */
import type {AppendMarkdownResult} from './graph.js'
import {AGENT_VIEW_DEFAULTS, clip, neutralizeDisplayText} from './protocol.js'

/** A block's first line, cut to the read views' line budget, and how many
 *  lines follow. */
const preview = (content: string): string => {
  const end = content.indexOf('\n')
  const line = clip(end < 0 ? content : content.slice(0, end), AGENT_VIEW_DEFAULTS.lineChars).text
  let more = 0
  for (let at = end; at >= 0; at = content.indexOf('\n', at + 1)) more += 1
  return more > 0 ? `${line} …(+${more} line${more === 1 ? '' : 's'})` : line
}

/** `Appended N blocks under "<target>" ^short (kind[, created]):` then the
 *  created blocks as an outline, one `- content  ^short` line each. Every line
 *  is neutralized whole — content, and an id too (a non-canonical id prints in
 *  full, and nothing stops it carrying control characters). */
export const renderAppendResult = (result: AppendMarkdownResult): string => {
  const {target, blocks} = result
  const facts = target.created ? `${target.kind}, created` : target.kind
  const title = JSON.stringify(preview(target.content))
  const lines = [
    `Appended ${blocks.length} block${blocks.length === 1 ? '' : 's'} under ${title} ^${target.shortId} (${facts}):`,
    ...blocks.map(block => `${'  '.repeat(block.depth)}- ${preview(block.content)}  ^${block.shortId}`),
  ]
  return lines.map(neutralizeDisplayText).join('\n')
}
