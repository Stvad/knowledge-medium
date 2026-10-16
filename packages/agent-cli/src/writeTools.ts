/* Shared by the km MCP write tools and the matching CLI verbs: the help text
 * both surfaces quote, and the rendering of an append result. Lives apart from
 * `cli.ts` because that module self-executes on import. */
import type {AppendMarkdownResult} from './graph.js'
import {neutralizeDisplayText} from './protocol.js'

/** How every write tool names where to write. */
export const WRITE_TARGET_HELP =
  'A target is a block id or a unique id prefix as printed (^3f2a9c1b); a [[Page name]] — found by alias, '
  + 'and created when missing exactly as typing that wikilink would (a date-literal name such as '
  + '[[2026-10-15]] is that daily note); or a date expression (today, yesterday, 2026-10-15, next monday) '
  + 'for that day\'s daily note, created when missing. A bare name only finds an EXISTING page — to create '
  + 'one, wrap it in [[…]].'

/** How to write a todo — composed from the built-in `todo` type. */
export const TODO_WRITE_HELP =
  'A todo is a block with properties {"types": ["todo"], "status": "open"} (create_block); mark it done '
  + 'with update_block properties {"status": "done"} — properties merge, so its other keys stay.'

const preview = (content: string): string => {
  const [first, ...rest] = content.split('\n')
  return rest.length > 0 ? `${first} …(+${rest.length} line${rest.length === 1 ? '' : 's'})` : first
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
