import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { parseReferences, renderWikilink } from '@/plugins/references/referenceParser.ts'
import { isValidTagName } from './config.ts'

export interface AppendTagResult {
  /** Total blocks considered. */
  total: number
  /** Blocks whose content was rewritten. */
  updated: number
  /** Blocks that already carried the tag (no-op, not failure). */
  alreadyTagged: number
}

const emptyResult = (blocks: readonly Block[]): AppendTagResult => ({
  total: blocks.length,
  updated: 0,
  alreadyTagged: 0,
})

const hasTagReference = (content: string, alias: string): boolean =>
  parseReferences(content).some(ref => ref.alias === alias)

/** Compose the next content. Preserves whatever trailing whitespace
 *  already exists; only inserts a separating space when the existing
 *  content is non-empty and doesn't already end with whitespace.
 *  Invalid tag names (empty, or containing `[[` / `]]`) are no-ops;
 *  callers should pre-validate with `isValidTagName` and surface the
 *  rejection at their UI entry point. */
export const appendTagToContent = (content: string, name: string): string => {
  if (!isValidTagName(name)) return content
  const trimmedName = name.trim()
  if (hasTagReference(content, trimmedName)) return content
  const separator = content.length === 0 || /\s$/.test(content) ? '' : ' '
  return `${content}${separator}${renderWikilink(trimmedName)}`
}

/** Append ` [[name]]` to every block's content (skipping blocks that
 *  already carry the tag). Read-only repos and invalid tag names are
 *  no-ops. All writes happen in a single tx so undo collapses to one
 *  entry. */
export const appendTagToBlocks = async (
  blocks: readonly Block[],
  name: string,
): Promise<AppendTagResult> => {
  if (blocks.length === 0 || !isValidTagName(name)) return emptyResult(blocks)
  const repo = blocks[0].repo
  if (repo.isReadOnly) return emptyResult(blocks)

  const trimmedName = name.trim()
  let updated = 0
  let alreadyTagged = 0

  await repo.tx(async tx => {
    for (const block of blocks) {
      const row = await tx.get(block.id)
      if (!row) continue
      if (hasTagReference(row.content, trimmedName)) {
        alreadyTagged += 1
        continue
      }
      const nextContent = appendTagToContent(row.content, trimmedName)
      if (nextContent === row.content) continue
      await tx.update(block.id, {content: nextContent})
      updated += 1
    }
  }, {scope: ChangeScope.BlockDefault, description: `append tag [[${trimmedName}]]`})

  return {total: blocks.length, updated, alreadyTagged}
}
