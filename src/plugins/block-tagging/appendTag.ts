import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { parseReferences, renderWikilink } from '@/plugins/references/referenceParser.ts'

export interface AppendTagResult {
  /** Total blocks considered. */
  total: number
  /** Blocks whose content was rewritten. */
  updated: number
  /** Blocks that already carried the tag (no-op, not failure). */
  alreadyTagged: number
}

/** The alias that `renderWikilink(name)` will actually emit. For
 *  benign names this is just `name`; for names that contain `]]` the
 *  renderer rewrites the closing delimiter so the output stays
 *  parseable, which means the *stored* alias diverges from the raw
 *  input. Anchoring the dedup check on this canonical form keeps the
 *  "already tagged" guard honest across repeated invocations. */
const canonicalAliasFor = (name: string): string => {
  const rendered = renderWikilink(name)
  const [first] = parseReferences(rendered)
  return first?.alias ?? name
}

const hasTagReference = (content: string, alias: string): boolean =>
  parseReferences(content).some(ref => ref.alias === alias)

/** Compose the next content. Preserves whatever trailing whitespace
 *  already exists; only inserts a separating space when the existing
 *  content is non-empty and doesn't already end with whitespace.
 *  Uses `renderWikilink` so a `]]`-containing tag name still emits
 *  syntactically valid wikilink text (the visible label is munged,
 *  see the helper's doc). */
export const appendTagToContent = (content: string, name: string): string => {
  const alias = canonicalAliasFor(name)
  if (hasTagReference(content, alias)) return content
  const separator = content.length === 0 || /\s$/.test(content) ? '' : ' '
  return `${content}${separator}${renderWikilink(name)}`
}

/** Append ` [[name]]` to every block's content (skipping blocks that
 *  already carry the tag). Read-only repos are a no-op. All writes
 *  happen in a single tx so undo collapses to one entry. */
export const appendTagToBlocks = async (
  blocks: readonly Block[],
  name: string,
): Promise<AppendTagResult> => {
  if (blocks.length === 0 || name.length === 0) {
    return {total: blocks.length, updated: 0, alreadyTagged: 0}
  }
  const repo = blocks[0].repo
  if (repo.isReadOnly) {
    return {total: blocks.length, updated: 0, alreadyTagged: 0}
  }

  const alias = canonicalAliasFor(name)
  let updated = 0
  let alreadyTagged = 0

  await repo.tx(async tx => {
    for (const block of blocks) {
      const row = await tx.get(block.id)
      if (!row) continue
      if (hasTagReference(row.content, alias)) {
        alreadyTagged += 1
        continue
      }
      const nextContent = appendTagToContent(row.content, name)
      if (nextContent === row.content) continue
      await tx.update(block.id, {content: nextContent})
      updated += 1
    }
  }, {scope: ChangeScope.BlockDefault, description: `append tag [[${alias}]]`})

  return {total: blocks.length, updated, alreadyTagged}
}
