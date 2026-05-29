import { ChangeScope, type BlockData } from '@/data/api'
import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import { isCollapsedProp } from '@/data/properties.js'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser.js'
import { keysBetween } from '../data/orderKey.ts'

type PastePosition = 'before' | 'after'
type PastePlacement = 'visible' | 'sibling'

interface PasteOptions {
  position?: PastePosition
  /** The currently rendered outline root. Paste uses this to avoid
   *  creating siblings outside a zoomed panel's visible subtree. */
  topLevelBlockId?: string
  /** `visible` follows outline navigation semantics; `sibling` keeps
   *  range paste before/after the selected range unless that would
   *  leave the visible subtree. */
  placement?: PastePlacement
}

interface ExistingParentInsertion {
  lower: string | null
  upper: string | null
}

const isBlankContent = (content: string): boolean => content.trim().length === 0

const isCollapsed = (properties: Record<string, unknown>): boolean => {
  const raw = properties[isCollapsedProp.name]
  return raw === undefined ? isCollapsedProp.defaultValue : isCollapsedProp.codec.decode(raw)
}

const insertionForFirstChild = (
  firstExistingOrderKey: string | undefined,
): ExistingParentInsertion => ({
  lower: null,
  upper: firstExistingOrderKey ?? null,
})

const insertionForSiblingRun = (
  siblings: BlockData[],
  targetId: string,
  position: PastePosition,
): ExistingParentInsertion => {
  const ix = siblings.findIndex(s => s.id === targetId)
  if (ix < 0) throw new Error(`paste target ${targetId} not found among siblings`)

  return position === 'after'
    ? {
      lower: siblings[ix]?.orderKey ?? null,
      upper: siblings[ix + 1]?.orderKey ?? null,
    }
    : {
      lower: siblings[ix - 1]?.orderKey ?? null,
      upper: siblings[ix]?.orderKey ?? null,
    }
}

/** Paste markdown text into the outline around a target block.
 *
 *  Rewrites parsed blocks into one `repo.tx`:
 *   - Empty targets absorb the first pasted root.
 *   - Root-level parsed blocks become visible siblings or first
 *     children depending on paste placement, expansion, and zoom.
 *   - Non-root parsed blocks keep their `parentId` (intra-paste tree
 *     structure), except children of an absorbed root become children
 *     of the target.
 *
 *  Returns the Block facades of the root-level pasted blocks in the
 *  resulting visible paste scope. */
export async function pasteMultilineText(
  pastedText: string,
  pasteTarget: Block,
  repo: Repo,
  {
    position = 'after',
    topLevelBlockId,
    placement = 'visible',
  }: PasteOptions = {},
): Promise<Block[]> {
  const targetData = pasteTarget.peek() ?? await pasteTarget.load()
  if (!targetData) return []

  const parsed = parseMarkdownToBlocks(pastedText)
  if (parsed.length === 0) return []

  const parsedRoots = parsed.filter(block => !block.parentId)

  const rootBlocks: Block[] = []
  await repo.tx(async tx => {
    const target = await tx.get(pasteTarget.id)
    if (!target) return

    const targetChildren = await tx.childrenOf(target.id, target.workspaceId)
    const targetIsTopLevel = topLevelBlockId === target.id
    const targetHasVisibleChildren = targetChildren.length > 0 && !isCollapsed(target.properties)
    const rootsAsChildren = targetIsTopLevel ||
      target.parentId === null ||
      (placement === 'visible' && position === 'after' && targetHasVisibleChildren)
    const rootParentId = rootsAsChildren ? target.id : target.parentId
    if (!rootParentId) return

    const rootInsertion = rootsAsChildren
      ? insertionForFirstChild(targetChildren[0]?.orderKey)
      : insertionForSiblingRun(
        await tx.childrenOf(rootParentId, target.workspaceId),
        target.id,
        position,
      )

    const absorbedRoot = isBlankContent(target.content) ? parsedRoots[0] : undefined
    if (absorbedRoot) {
      await tx.update(target.id, {content: absorbedRoot.content})
      rootBlocks.push(repo.block(target.id))
    }

    const blocksToCreate = parsed.filter(block => block.id !== absorbedRoot?.id)
    const createdParsedIds = new Set(blocksToCreate.map(block => block.id))
    const finalParentId = (block: ParsedBlock): string => {
      if (!block.parentId) return rootParentId
      if (block.parentId === absorbedRoot?.id) return target.id
      return block.parentId
    }

    const existingParentGroups = new Map<string, ParsedBlock[]>()
    for (const block of blocksToCreate) {
      const parentId = finalParentId(block)
      if (createdParsedIds.has(parentId)) continue
      const group = existingParentGroups.get(parentId) ?? []
      group.push(block)
      existingParentGroups.set(parentId, group)
    }

    const orderKeysByParsedId = new Map<string, string>()
    for (const [parentId, blocks] of existingParentGroups) {
      const insertion = parentId === rootParentId
        ? rootInsertion
        : insertionForFirstChild(
          parentId === target.id
            ? targetChildren[0]?.orderKey
            : (await tx.childrenOf(parentId, target.workspaceId))[0]?.orderKey,
        )
      const keys = keysBetween(insertion.lower, insertion.upper, blocks.length)
      blocks.forEach((block, index) => orderKeysByParsedId.set(block.id, keys[index]))
    }

    for (const block of blocksToCreate) {
      const parentId = finalParentId(block)
      const id = await tx.create({
        id: block.id,
        workspaceId: target.workspaceId,
        parentId,
        orderKey: orderKeysByParsedId.get(block.id) ?? block.orderKey,
        content: block.content,
      })
      if (!block.parentId) rootBlocks.push(repo.block(id))
    }
  }, {scope: ChangeScope.BlockDefault, description: 'paste multiline text'})

  return rootBlocks
}

export async function pasteFromClipboard(
  pasteTarget: Block,
  repo: Repo,
  options: PasteOptions = {},
): Promise<Block[]> {
  const text = await navigator.clipboard.readText()
  if (!text) return []
  return pasteMultilineText(text, pasteTarget, repo, options)
}
