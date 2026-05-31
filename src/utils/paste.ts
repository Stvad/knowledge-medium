import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import { isCollapsedProp } from '@/data/properties.js'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser.js'
import { keysBetween } from '../data/orderKey.ts'

type PastePosition = 'before' | 'after'
type PastePlacement = 'visible' | 'sibling'

interface PasteOptions {
  position?: PastePosition
  /** Root of the surface's visible subtree (see
   *  `BlockContextType.scopeRootId`). Paste uses this to avoid creating
   *  siblings outside the visible scope. */
  scopeRootId?: string
  /** `visible` follows outline navigation semantics; `sibling` keeps
   *  range paste before/after the selected range unless that would
   *  leave the visible subtree. */
  placement?: PastePlacement
}

interface ExistingParentInsertion {
  lower: string | null
  upper: string | null
}

interface RootDestination {
  rootParentId: string
  rootInsertion: ExistingParentInsertion
  targetChildren: BlockData[]
}

export interface EditModePasteSelection {
  from: number
  to?: number
}

export interface EditModeMultilinePastePlan {
  parsed: ParsedBlock[]
  absorbedRoot: ParsedBlock
  targetContent: string
  focusOffsetInTarget: number
  suffix: string
}

export interface EditModeMultilinePasteResult {
  pasted: Block[]
  focusBlock: Block
  focusOffset: number
}

const isBlankContent = (content: string): boolean => content.trim().length === 0

const isCollapsed = (properties: Record<string, unknown>): boolean => {
  const raw = properties[isCollapsedProp.name]
  return raw === undefined ? isCollapsedProp.defaultValue : isCollapsedProp.codec.decode(raw)
}

const editorContentForFirstPastedLine = (
  pastedText: string,
  fallback: string,
): string => {
  const line = pastedText.split('\n').find(item => item.trim().length > 0)
  if (line === undefined) return fallback

  const bullet = line.trim().match(/^[-*+]\s+(.*)$/)
  if (bullet) return bullet[1]

  return line.replace(/\r$/, '')
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

const resolveRootDestination = async (
  tx: Tx,
  target: BlockData,
  {
    position,
    scopeRootId,
    placement,
  }: Required<Pick<PasteOptions, 'position' | 'placement'>> & Pick<PasteOptions, 'scopeRootId'>,
): Promise<RootDestination> => {
  const targetChildren = await tx.childrenOf(target.id, target.workspaceId)
  const targetIsScopeRoot = scopeRootId === target.id
  const targetHasVisibleChildren = targetChildren.length > 0 && !isCollapsed(target.properties)
  const rootsAsChildren = targetIsScopeRoot ||
    target.parentId === null ||
    (placement === 'visible' && position === 'after' && targetHasVisibleChildren)
  const rootParentId = rootsAsChildren ? target.id : target.parentId
  if (!rootParentId) throw new Error(`paste target ${target.id} has no visible insertion parent`)

  const rootInsertion = rootsAsChildren
    ? insertionForFirstChild(targetChildren[0]?.orderKey)
    : insertionForSiblingRun(
      await tx.childrenOf(rootParentId, target.workspaceId),
      target.id,
      position,
    )

  return {rootParentId, rootInsertion, targetChildren}
}

export const planEditModeMultilinePaste = (
  pastedText: string,
  currentContent: string,
  selection: EditModePasteSelection,
): EditModeMultilinePastePlan | null => {
  const parsed = parseMarkdownToBlocks(pastedText)
  const absorbedRoot = parsed.find(block => !block.parentId)
  if (!absorbedRoot) return null

  const from = Math.max(0, Math.min(selection.from, currentContent.length))
  const to = Math.max(from, Math.min(selection.to ?? selection.from, currentContent.length))
  const prefix = currentContent.slice(0, from)
  const suffix = currentContent.slice(to)
  const createsAdditionalBlocks = parsed.some(block => block.id !== absorbedRoot.id)
  const contentBeforeStructuralBreak = `${prefix}${editorContentForFirstPastedLine(
    pastedText,
    absorbedRoot.content,
  )}`

  return {
    parsed,
    absorbedRoot,
    targetContent: createsAdditionalBlocks
      ? contentBeforeStructuralBreak
      : `${contentBeforeStructuralBreak}${suffix}`,
    focusOffsetInTarget: contentBeforeStructuralBreak.length,
    suffix: createsAdditionalBlocks ? suffix : '',
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
    scopeRootId,
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

    const {rootParentId, rootInsertion, targetChildren} = await resolveRootDestination(tx, target, {
      position,
      scopeRootId,
      placement,
    })

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

export async function pasteEditModeMultilineText(
  plan: EditModeMultilinePastePlan,
  pasteTarget: Block,
  repo: Repo,
  options: Pick<PasteOptions, 'scopeRootId'> = {},
): Promise<EditModeMultilinePasteResult | null> {
  const rootBlocks: Block[] = []
  let focusBlock = pasteTarget
  let focusOffset = plan.focusOffsetInTarget

  await repo.tx(async tx => {
    const target = await tx.get(pasteTarget.id)
    if (!target) return

    const {rootParentId, rootInsertion, targetChildren} = await resolveRootDestination(tx, target, {
      position: 'after',
      scopeRootId: options.scopeRootId,
      placement: 'sibling',
    })

    await tx.update(target.id, {content: plan.targetContent})
    rootBlocks.push(repo.block(target.id))

    const blocksToCreate = plan.parsed.filter(block => block.id !== plan.absorbedRoot.id)
    const createdParsedIds = new Set(blocksToCreate.map(block => block.id))
    const finalParentId = (block: ParsedBlock): string => {
      if (!block.parentId) return rootParentId
      if (block.parentId === plan.absorbedRoot.id) return target.id
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

    const lastCreatedBlock = blocksToCreate.at(-1)
    for (const block of blocksToCreate) {
      const parentId = finalParentId(block)
      const isFocusBlock = block.id === lastCreatedBlock?.id
      const id = await tx.create({
        id: block.id,
        workspaceId: target.workspaceId,
        parentId,
        orderKey: orderKeysByParsedId.get(block.id) ?? block.orderKey,
        content: isFocusBlock ? `${block.content}${plan.suffix}` : block.content,
      })
      if (!block.parentId) rootBlocks.push(repo.block(id))
      if (isFocusBlock) {
        focusBlock = repo.block(id)
        focusOffset = block.content.length
      }
    }
  }, {scope: ChangeScope.BlockDefault, description: 'paste multiline text at editor selection'})

  return {pasted: rootBlocks, focusBlock, focusOffset}
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
