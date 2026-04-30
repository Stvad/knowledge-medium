import { ChangeScope } from '@/data/api'
import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import { parseMarkdownToBlocks } from '@/utils/markdownParser.ts'
import { keysBetween } from '@/data/internals/orderKey.ts'

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

  const rootCount = parsed.reduce((n, b) => n + (b.parentId ? 0 : 1), 0)

  const rootBlocks: Block[] = []
  await repo.tx(async tx => {
    // Compute order keys for the new root-level siblings between the
    // target and its before/after neighbour. Earlier versions just
    // suffixed the target's order_key (e.g. `${baseKey}~a0`), which
    // always sorts AFTER the target lexicographically — so 'before'
    // silently inserted after the target. Read the actual neighbours
    // and use keysBetween so 'before' lands above the target.
    const siblings = await tx.childrenOf(parentId, targetData.workspaceId)
    const ix = siblings.findIndex(s => s.id === pasteTarget.id)
    const lower = position === 'after'
      ? siblings[ix]?.orderKey ?? null
      : siblings[ix - 1]?.orderKey ?? null
    const upper = position === 'after'
      ? siblings[ix + 1]?.orderKey ?? null
      : siblings[ix]?.orderKey ?? null
    const rootKeys = rootCount > 0 ? keysBetween(lower, upper, rootCount) : []

    let rootIndex = 0
    for (const block of parsed) {
      const isRoot = !block.parentId
      const orderKey = isRoot ? rootKeys[rootIndex++] : block.orderKey
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
