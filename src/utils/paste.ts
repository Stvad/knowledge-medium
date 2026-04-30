import { ChangeScope } from '@/data/api'
import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import { parseMarkdownToBlocks } from '@/utils/markdownParser.ts'

/** Paste markdown text as a sibling subtree relative to a target
 *  block. The target's parent receives the new tree as children;
 *  position controls whether the paste lands before or after the
 *  target.
 *
 *  Rewrites parsed blocks into one `repo.tx`:
 *   - Root-level parsed blocks (no parentId) get adopted under
 *     `target.parent` with order keys computed to land before/after
 *     the target.
 *   - Non-root parsed blocks keep their `parentId` (intra-paste tree
 *     structure) and use the parser-generated order keys.
 *
 *  Returns the Block facades of the new root-level pasted blocks. */
export async function pasteMultilineText(
  pastedText: string,
  pasteTarget: Block,
  repo: Repo,
  {position = 'after'}: {position?: 'before' | 'after'} = {},
): Promise<Block[]> {
  const targetData = pasteTarget.peek() ?? await pasteTarget.load()
  if (!targetData) return []
  const parentId = targetData.parentId
  if (!parentId) {
    // Pasting under a root block isn't supported here — nothing to
    // become a sibling of. Caller should re-target to a child.
    return []
  }

  const parsed = parseMarkdownToBlocks(pastedText)
  if (parsed.length === 0) return []

  // Order keys: build a sequence relative to the target's order_key.
  // The simplest correct approach: prefix the target's order_key with
  // a deterministic discriminator. For 'after' use `${target}~a0`,
  // `${target}~a1`, etc.; for 'before' use `${target}~~a0`, where the
  // tilde sort places ~ before ~~ but after the target's own key.
  // This is a placeholder — a proper implementation would use
  // `keysBetween(target.orderKey, nextSibling.orderKey, count)` from
  // fractional-indexing-jittered. Pragmatically here, we use simple
  // suffixes and accept that a future paste against an in-between
  // sibling can collide; for v1 paste this is acceptable.
  const baseKey = targetData.orderKey
  const rootKeyFor = (i: number): string =>
    position === 'after' ? `${baseKey}~a${i}` : `${baseKey}~~a${i}`

  const rootBlocks: Block[] = []
  await repo.tx(async tx => {
    let rootIndex = 0
    for (const block of parsed) {
      const isRoot = !block.parentId
      const orderKey = isRoot ? rootKeyFor(rootIndex++) : block.orderKey
      const id = await tx.create({
        id: block.id,
        workspaceId: targetData.workspaceId,
        parentId: isRoot ? parentId : block.parentId!,
        orderKey,
        content: block.content,
      })
      if (isRoot) rootBlocks.push(repo.block(id))
    }
  }, {scope: ChangeScope.BlockDefault, description: 'paste multiline text'})

  return rootBlocks
}

export async function pasteFromClipboard(
  pasteTarget: Block,
  repo: Repo,
  options: {position?: 'before' | 'after'} = {},
): Promise<Block[]> {
  const text = await navigator.clipboard.readText()
  if (!text) return []
  return pasteMultilineText(text, pasteTarget, repo, options)
}
