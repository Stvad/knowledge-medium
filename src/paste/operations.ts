import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import { isCollapsedProp } from '@/data/properties.js'
import { deleteBlock, moveBlocksInTx, revealChildren, type MoveTarget } from '@/data/mutators'
import { visibleChildrenOf } from '@/data/visibleChildren'
import { pluralize } from '@/utils/pluralize.js'
import { showError, showInfo } from '@/utils/toast.js'
import { disarmCut, getArmedCut, matchArmedCut } from './armedCut.js'
import {
  parseMarkdownToBlocks,
  parsedBlocksFromOutline,
  type OutlineNode,
  type ParsedBlock,
} from '@/utils/markdownParser.js'
import { keysBetween } from '../data/orderKey.ts'
import { keysImmediatelyAfter, keysImmediatelyBefore } from '../data/orderKeyPlacement.ts'
import { FacetRuntime } from '@/facets/facet.js'
import { captureMediaVerb } from './captureMediaVerb.js'
import { pasteDecisionVerb, type PasteDecision, type PasteRequest } from './decision.js'

type PastePosition = 'before' | 'after'
type PastePlacement = 'visible' | 'sibling'

interface PasteOptions {
  position?: PastePosition
  /** Root of the surface's visible subtree (see
   *  `BlockContextType.scopeRootId`). Paste uses this to avoid creating
   *  siblings outside the visible scope. */
  scopeRootId?: string
  /** Only consulted for `position: 'after'`. `visible` (the default) follows
   *  outline navigation — "after" an expanded block IS its first-child slot.
   *  `sibling` keeps a range paste beside the selected range rather than
   *  inside it (multi-select `paste_*_selection`). `resolveRootDestination`
   *  also selects it internally when the absorbed root's children would
   *  otherwise collide with it. */
  placement?: PastePlacement
}

interface ExistingParentInsertion {
  /** Produce `n` ascending order keys for the chosen insertion slot. A
   *  sibling-run insertion places the run EXACTLY adjacent to the target
   *  (between it and its neighbour on that side), breaking a tie by re-keying
   *  the run when one blocks the slot (#198/#182) — async because that re-key
   *  is a tx write. Non-tie inputs reduce to a plain `keysBetween`. */
  keys: (n: number) => Promise<string[]>
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

export type PasteChordIntent = 'split' | 'single-block'

/** Classify a keydown as a paste chord. The paste `ClipboardEvent` that
 *  follows carries no modifier state, so callers capture the intent here
 *  (on keydown) and route the subsequent paste accordingly:
 *   - `split` (Cmd/Ctrl+V) — multi-line text splits into a block tree.
 *   - `single-block` (Cmd/Ctrl+Shift+V) — text drops into the current
 *     block verbatim (Roam's "paste as plain text").
 *  Returns null for non-paste keys. Browsers report the key as 'v' or
 *  'V' depending on Shift, and AltGr/Option pastes are excluded. */
export const pasteChordIntent = (
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>,
): PasteChordIntent | null => {
  const isPasteChord = (event.metaKey || event.ctrlKey) && !event.altKey &&
    (event.key === 'v' || event.key === 'V')
  if (!isPasteChord) return null
  return event.shiftKey ? 'single-block' : 'split'
}

export interface SingleBlockPastePlan {
  insert: string
  from: number
  to: number
  cursor: number
}

/** Plan a verbatim paste into the current block: replace the selected
 *  range with the pasted text, keeping its newlines. CRLF/CR are
 *  normalized to LF to match CodeMirror's own line-ending normalization,
 *  so the resulting cursor offset can't land past the document end. */
export const planSingleBlockPaste = (
  pastedText: string,
  selection: { from: number; to: number },
): SingleBlockPastePlan => {
  const insert = pastedText.replace(/\r\n?/g, '\n')
  return {
    insert,
    from: selection.from,
    to: selection.to,
    cursor: selection.from + insert.length,
  }
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
  // First-child insert: `null` lower bound, so no tie can block it.
  keys: async n => keysBetween(null, firstExistingOrderKey ?? null, n),
})

const insertionForSiblingRun = (
  tx: Tx,
  parentId: string,
  siblings: BlockData[],
  targetId: string,
  position: PastePosition,
): ExistingParentInsertion => {
  const ix = siblings.findIndex(s => s.id === targetId)
  if (ix < 0) throw new Error(`paste target ${targetId} not found among siblings`)

  // Place the run EXACTLY adjacent to the target (between it and its neighbour
  // on the requested side), breaking a tie by re-keying the run when one blocks
  // the slot. Non-tie inputs reduce to `keysBetween(siblings[ix], siblings[ix+1])`
  // (after) / `keysBetween(siblings[ix-1], siblings[ix])` (before).
  return {
    keys: n => position === 'after'
      ? keysImmediatelyAfter(tx, parentId, siblings, ix, n)
      : keysImmediatelyBefore(tx, parentId, siblings, ix, n),
  }
}

/** A scope-root / parentless target has no sibling slot, so its pasted roots
 *  become first children — i.e. they land AFTER it — whatever `position` says.
 *  Both the destination and the absorption rule below turn on this. */
const hasNoSiblingSlot = (target: BlockData, scopeRootId: string | undefined): boolean =>
  scopeRootId === target.id || target.parentId === null

/** THE placement rule for a run of pasted roots: whether they land in
 *  `target`'s own child list (its first-child slot) rather than beside it.
 *  Shared by the text paste and by a paste that completes a cut, so the two
 *  can't put the same paste in different places. */
const rootsLandAsChildren = (
  target: BlockData,
  targetHasVisibleChildren: boolean,
  {position, placement, scopeRootId}: {
    position: PastePosition
    placement: PastePlacement
    scopeRootId: string | undefined
  },
): boolean =>
  // With no sibling slot, roots land in the target's child list whatever
  // `placement` says.
  hasNoSiblingSlot(target, scopeRootId) ||
  (placement === 'visible' && position === 'after' && targetHasVisibleChildren)

/** Pasted root a blank target absorbs (it BECOMES that root). The run is
 *  contiguous with the target, so the target takes whichever end it sits at:
 *  the head for `after`, the TAIL when the run lands strictly before it.
 *  Absorbing the head in both cases left the target's UNMOVED order key above
 *  the keys computed below it, so a multi-root paste-before came out reversed
 *  (#497). */
const absorbedRootFor = (
  target: BlockData,
  parsedRoots: readonly ParsedBlock[],
  position: PastePosition,
  scopeRootId: string | undefined,
): ParsedBlock | undefined => {
  if (!isBlankContent(target.content)) return undefined
  return position === 'before' && !hasNoSiblingSlot(target, scopeRootId)
    ? parsedRoots.at(-1)
    : parsedRoots[0]
}

const resolveRootDestination = async (
  tx: Tx,
  target: BlockData,
  {
    position,
    scopeRootId,
    placement,
    parsed,
    absorbedRootId,
  }: Required<Pick<PasteOptions, 'position' | 'placement'>> & Pick<PasteOptions, 'scopeRootId'> & {
    parsed: readonly ParsedBlock[]
    /** Pasted root the target absorbs (it BECOMES that root), if any. */
    absorbedRootId: string | undefined
  },
): Promise<RootDestination> => {
  // Absorbing makes the target root #1, so root #1's own children reparent onto
  // it (`planPastePlacement`). Roots #2..N must not ALSO take that first-child
  // slot or the clipboard's top two levels merge, leaving a peer of root #1
  // indistinguishable from its children. Both surfaces absorb, so the rule
  // lives here rather than at either call site.
  const absorbedRootHasChildren = absorbedRootId !== undefined &&
    parsed.some(block => block.parentId === absorbedRootId)
  const effectivePlacement = absorbedRootHasChildren ? 'sibling' : placement

  const targetChildren = await visibleChildrenOf(tx, target.id, target.workspaceId)
  const targetHasVisibleChildren = targetChildren.length > 0 && !isCollapsed(target.properties)
  // With no sibling slot, roots #2..N land in the target's child list even
  // when absorption forced `sibling` — a nested clipboard still merges there.
  // Accepted: the alternative is to stop absorbing into a zoomed title, which
  // is a bigger behaviour change than this guard.
  const rootsAsChildren = rootsLandAsChildren(target, targetHasVisibleChildren, {
    position,
    placement: effectivePlacement,
    scopeRootId,
  })
  // Type guard, not a live check: a parentless target always takes the branch
  // above, so the sibling branch always has a parent.
  const rootParentId = rootsAsChildren ? target.id : target.parentId
  if (!rootParentId) throw new Error(`paste target ${target.id} has no visible insertion parent`)

  // Reveal a collapsed target whenever anything lands under it, so the focused
  // paste isn't hidden inside a closed subtree (same invariant as indent /
  // moveVertical / create-child). `absorbedRootHasChildren` is part of the
  // condition because those children reparent onto the target regardless of
  // `rootsAsChildren`. No-op when target is already expanded.
  if (rootsAsChildren || absorbedRootHasChildren) await revealChildren(tx, target.id)

  const rootInsertion = rootsAsChildren
    ? insertionForFirstChild(targetChildren[0]?.orderKey)
    : insertionForSiblingRun(
      tx,
      rootParentId,
      await tx.childrenOf(rootParentId, target.workspaceId),
      target.id,
      position,
    )

  return {rootParentId, rootInsertion, targetChildren}
}

interface PastePlacementPlan {
  /** Parsed blocks to create — the absorbed root (if any) is excluded. */
  blocksToCreate: ParsedBlock[]
  /** A parsed block's final parentId: absorbed-root children reparent onto
   *  `target`, parentless blocks go to the resolved root parent. */
  finalParentId: (block: ParsedBlock) => string
  /** Order key to assign each created block, by parsed id. Blocks landing
   *  among a parent's existing children get fresh keys between neighbours;
   *  blocks whose parent is itself being created keep their parsed orderKey. */
  orderKeysByParsedId: Map<string, string>
}

/** Shared placement math for both multiline-paste paths: which blocks to
 *  create, where each lands, and the order keys for blocks inserted among an
 *  existing parent's children. The ordering invariants live in the
 *  keysBetween / insertionForFirstChild primitives this delegates to — this
 *  only groups blocks by destination parent and assigns the returned keys. */
const planPastePlacement = async (
  tx: Tx,
  target: BlockData,
  parsedBlocks: readonly ParsedBlock[],
  absorbedRootId: string | undefined,
  {rootParentId, rootInsertion, targetChildren}: RootDestination,
): Promise<PastePlacementPlan> => {
  const blocksToCreate = parsedBlocks.filter(block => block.id !== absorbedRootId)
  const createdParsedIds = new Set(blocksToCreate.map(block => block.id))
  const finalParentId = (block: ParsedBlock): string => {
    if (!block.parentId) return rootParentId
    if (block.parentId === absorbedRootId) return target.id
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
    const keys = await insertion.keys(blocks.length)
    blocks.forEach((block, index) => orderKeysByParsedId.set(block.id, keys[index]))
  }

  return {blocksToCreate, finalParentId, orderKeysByParsedId}
}

/** `pasted` is clipboard text to parse as markdown, or a block tree a paste
 *  decision already built. */
export const planEditModeMultilinePaste = (
  pasted: string | readonly OutlineNode[],
  currentContent: string,
  selection: EditModePasteSelection,
): EditModeMultilinePastePlan | null => {
  const parsed = typeof pasted === 'string' ? parseMarkdownToBlocks(pasted) : parsedBlocksFromOutline(pasted)
  const absorbedRoot = parsed.find(block => !block.parentId)
  if (!absorbedRoot) return null

  const from = Math.max(0, Math.min(selection.from, currentContent.length))
  const to = Math.max(from, Math.min(selection.to ?? selection.from, currentContent.length))
  const prefix = currentContent.slice(0, from)
  const suffix = currentContent.slice(to)
  const createsAdditionalBlocks = parsed.some(block => block.id !== absorbedRoot.id)
  // A pre-built tree's root content is already final. A multi-line parsed
  // root is an atomic token (`OutlineToken`'s `atomic` kind) — the "merge
  // only the first source line" rule would drop its body, so merge it whole.
  // Single-line parsed roots keep the first-line merge (strips the bullet
  // marker, preserves leading whitespace at the cursor).
  const mergedFirstContent = typeof pasted !== 'string' || absorbedRoot.content.includes('\n')
    ? absorbedRoot.content
    : editorContentForFirstPastedLine(pasted, absorbedRoot.content)
  const contentBeforeStructuralBreak = `${prefix}${mergedFirstContent}`

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

/** Paste markdown text into the outline around a target block, parsed into
 *  a block tree and placed per {@link pasteParsedBlocks}. */
export async function pasteMultilineText(
  pastedText: string,
  pasteTarget: Block,
  repo: Repo,
  options: PasteOptions = {},
): Promise<Block[]> {
  return pasteParsedBlocks(parseMarkdownToBlocks(pastedText), pasteTarget, repo, options)
}

/** Paste a resolved (non-media) decision around `pasteTarget`, placed per
 *  {@link pasteParsedBlocks}. */
export async function pasteResolvedDecision(
  resolved: ResolvedTextPaste,
  pasteTarget: Block,
  repo: Repo,
  options: PasteOptions = {},
): Promise<Block[]> {
  return pasteParsedBlocks(parsedBlocksFor(resolved), pasteTarget, repo, options)
}

/** The blocks a decision pastes: the tree it built, else its text parsed as
 *  markdown, or kept whole as one block for `single-block`. Blank text pastes
 *  nothing either way (a whitespace-only block would clobber a blank target). */
const parsedBlocksFor = ({decision, text}: ResolvedTextPaste): ParsedBlock[] => {
  if (decision.kind === 'split') return decision.blocks ? parsedBlocksFromOutline(decision.blocks) : parseMarkdownToBlocks(text)
  return isBlankContent(text) ? [] : parsedBlocksFromOutline([{content: text}])
}

/** Paste parsed blocks into the outline around a target block.
 *
 *  Rewrites parsed blocks into one `repo.tx`:
 *   - Empty targets absorb a pasted root — the first, or the LAST when the
 *     run lands strictly before the target (`absorbedRootFor`).
 *   - Root-level parsed blocks become visible siblings or first
 *     children depending on paste placement, expansion, and zoom.
 *   - Non-root parsed blocks keep their `parentId` (intra-paste tree
 *     structure), except children of an absorbed root become children
 *     of the target.
 *
 *  Returns the Block facades of the root-level pasted blocks in CLIPBOARD
 *  order (which is also their resulting visible order), the absorbed root
 *  appearing at its own position in that sequence rather than first. */
async function pasteParsedBlocks(
  parsed: readonly ParsedBlock[],
  pasteTarget: Block,
  repo: Repo,
  {
    position = 'after',
    scopeRootId,
    placement = 'visible',
  }: PasteOptions,
): Promise<Block[]> {
  if (parsed.length === 0) return []
  const targetData = pasteTarget.peek() ?? await pasteTarget.load()
  if (!targetData) return []

  const parsedRoots = parsed.filter(block => !block.parentId)

  const rootBlocks: Block[] = []
  await repo.tx(async tx => {
    const target = await tx.get(pasteTarget.id)
    if (!target) return

    // Decide absorption BEFORE resolving the destination — it is an input to
    // the placement rule there, not an independent step.
    const absorbedRoot = absorbedRootFor(target, parsedRoots, position, scopeRootId)

    const destination = await resolveRootDestination(tx, target, {
      position,
      scopeRootId,
      placement,
      parsed,
      absorbedRootId: absorbedRoot?.id,
    })

    // Keyed by PARSED root so the return value is emitted in clipboard order
    // below: the absorbed root is not always #1, but callers focus `pasted[0]`
    // and expect the first root the user pasted.
    const blockByRootId = new Map<string, Block>()
    if (absorbedRoot) {
      await tx.update(target.id, {content: absorbedRoot.content})
      blockByRootId.set(absorbedRoot.id, repo.block(target.id))
    }

    const {blocksToCreate, finalParentId, orderKeysByParsedId} = await planPastePlacement(
      tx, target, parsed, absorbedRoot?.id, destination,
    )

    for (const block of blocksToCreate) {
      const parentId = finalParentId(block)
      const id = await tx.create({
        id: block.id,
        workspaceId: target.workspaceId,
        parentId,
        orderKey: orderKeysByParsedId.get(block.id) ?? block.orderKey,
        content: block.content,
      })
      if (!block.parentId) blockByRootId.set(block.id, repo.block(id))
    }

    rootBlocks.push(...parsedRoots.flatMap(root => blockByRootId.get(root.id) ?? []))
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

    // `visible`: the slot right after the edited line is its first-child slot
    // once the block has children, so a paste stays contiguous with the line it
    // was split from. `resolveRootDestination` overrides this when the absorbed
    // root's own children already claim that slot.
    const destination = await resolveRootDestination(tx, target, {
      position: 'after',
      scopeRootId: options.scopeRootId,
      placement: 'visible',
      parsed: plan.parsed,
      absorbedRootId: plan.absorbedRoot.id,
    })

    await tx.update(target.id, {content: plan.targetContent})
    rootBlocks.push(repo.block(target.id))

    const {blocksToCreate, finalParentId, orderKeysByParsedId} = await planPastePlacement(
      tx, target, plan.parsed, plan.absorbedRoot.id, destination,
    )

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

// ──── a paste that completes a cut ────

/** What a paste of the armed cut did. {@link pasteArmedCut} returns `null`
 *  instead when the paste is not the cut: paste its text as usual. */
export type CutPasteOutcome =
  /** The cut blocks themselves now sit at the paste destination. */
  | {kind: 'moved'; blocks: Block[]}
  /** Recognised as the cut but declined, with a toast. Nothing changed, and
   *  the caller must NOT paste the text instead: the originals are still in
   *  place, so that would duplicate them. */
  | {kind: 'refused'}

type CutMoveResult =
  | {kind: 'moved'; rootIds: string[]; missing: number}
  /** Consumed by an overlapping paste, or every cut block was deleted since:
   *  either way the text pastes as usual, and nothing is left to duplicate. */
  | {kind: 'not-a-cut'}
  | {kind: 'refused'; message: string}

/** Is `id` strictly inside one of `rootIds`' subtrees? Walks `parentId`
 *  through the tx, with a `seen` guard against a corrupt cycle. */
const isInsideAny = async (tx: Tx, id: string, rootIds: ReadonlySet<string>): Promise<boolean> => {
  const seen = new Set<string>([id])
  let current = (await tx.get(id))?.parentId ?? null
  while (current !== null && !seen.has(current)) {
    if (rootIds.has(current)) return true
    seen.add(current)
    current = (await tx.get(current))?.parentId ?? null
  }
  return false
}

/** Where the cut roots go for a paste at `target`: wherever this paste's
 *  text roots would ({@link rootsLandAsChildren}), except that nothing
 *  absorbs. A moved block can't BECOME the target the way pasted text does,
 *  so a blank target with no children and no properties is replaced
 *  instead: the roots take its slot and it is deleted. */
const cutDestination = async (
  tx: Tx,
  target: BlockData,
  options: {position: PastePosition; placement: PastePlacement; scopeRootId: string | undefined},
): Promise<{move: MoveTarget; revealTarget: boolean; replacesTarget: boolean}> => {
  const children = await tx.childrenOf(target.id, target.workspaceId)
  const replaceable = isBlankContent(target.content) && children.length === 0 &&
    Object.keys(target.properties).length === 0 && !hasNoSiblingSlot(target, options.scopeRootId)
  if (replaceable) {
    return {
      move: {parentId: target.parentId, position: {kind: 'before', siblingId: target.id}},
      revealTarget: false,
      replacesTarget: true,
    }
  }

  const visible = await visibleChildrenOf(tx, target.id, target.workspaceId)
  const hasVisibleChildren = visible.length > 0 && !isCollapsed(target.properties)
  if (rootsLandAsChildren(target, hasVisibleChildren, options)) {
    return {
      move: {
        parentId: target.id,
        position: visible[0] ? {kind: 'before', siblingId: visible[0].id} : {kind: 'last'},
      },
      revealTarget: true,
      replacesTarget: false,
    }
  }
  return {
    move: {parentId: target.parentId, position: {kind: options.position, siblingId: target.id}},
    revealTarget: false,
    replacesTarget: false,
  }
}

/**
 * Complete the armed cut (`./armedCut.ts`) as a MOVE when `text`, the
 * clipboard text this paste would insert, is what the cut put there.
 *
 * Cut no longer deletes, so EVERY paste surface calls this before its text
 * paste; one that skipped it would paste copies beside the originals. The
 * callers: the block-shell paste, the editor's paste, and
 * {@link pasteFromClipboard} (vim and multi-select `p`).
 *
 * One transaction, one undo step. Liveness, descendant pruning and the
 * "inside the cut" refusal are decided inside it, against the rows it moves.
 */
export async function pasteArmedCut(
  text: string,
  pasteTarget: Block,
  repo: Repo,
  {position = 'after', placement = 'visible', scopeRootId}: PasteOptions = {},
): Promise<CutPasteOutcome | null> {
  const targetData = pasteTarget.peek() ?? await pasteTarget.load()
  if (!targetData) return null
  const match = await matchArmedCut(text, targetData.workspaceId)
  if (!match) return null
  if (match.kind === 'mismatch') {
    // The clipboard has moved on, so this cut can't be pasted any more;
    // dropping it also clears its dim.
    disarmCut(match.cut.cutId)
    return null
  }
  if (match.kind === 'other-workspace') {
    showInfo("Blocks can't move between workspaces, so this pasted a copy")
    return null
  }
  const {cut} = match

  let result: CutMoveResult
  try {
    result = await repo.tx(async (tx): Promise<CutMoveResult> => {
      // The cut is checked and consumed INSIDE the tx: the write lock orders
      // overlapping pastes, so a second one finds it spent and pastes text, as
      // a second ⌘V does. Should the commit fail after the disarm, the cut is
      // lost but nothing moved, so the user can cut again.
      if (getArmedCut()?.cutId !== cut.cutId) return {kind: 'not-a-cut'}
      const target = await tx.get(pasteTarget.id)
      if (!target || target.deleted) {
        return {kind: 'refused', message: 'The block you pasted at no longer exists'}
      }
      const live: string[] = []
      for (const id of cut.rootIds) {
        const row = await tx.get(id)
        if (row && !row.deleted) live.push(id)
      }
      if (live.length === 0) {
        disarmCut(cut.cutId)
        return {kind: 'not-a-cut'}
      }

      const liveSet = new Set(live)
      if (liveSet.has(target.id) || await isInsideAny(tx, target.id, liveSet)) {
        return {kind: 'refused', message: "Can't paste cut blocks inside themselves"}
      }
      const roots: string[] = []
      for (const id of live) {
        if (!await isInsideAny(tx, id, liveSet)) roots.push(id)
      }

      const destination = await cutDestination(tx, target, {position, placement, scopeRootId})
      await moveBlocksInTx(tx, roots, destination.move)
      if (destination.revealTarget) await revealChildren(tx, target.id)
      if (destination.replacesTarget) await tx.run(deleteBlock, {id: target.id})
      disarmCut(cut.cutId)
      return {kind: 'moved', rootIds: roots, missing: cut.rootIds.length - live.length}
    }, {scope: ChangeScope.BlockDefault, description: 'paste cut blocks'})
  } catch (error) {
    // DOM paste handlers `void` this after `preventDefault`, so a throw would
    // drop the paste silently, and falling back to the text would duplicate.
    console.error('[paste] completing the cut failed', error)
    showError("Couldn't move the cut blocks. Nothing changed.")
    return {kind: 'refused'}
  }

  if (result.kind === 'not-a-cut') return null
  if (result.kind === 'refused') {
    showError(result.message)
    return {kind: 'refused'}
  }
  if (result.missing > 0) {
    showInfo(`${pluralize(result.missing, 'cut block')} no longer existed; moved the rest`)
  }
  return {kind: 'moved', blocks: result.rootIds.map(id => repo.block(id))}
}

/** The applied paste once any media capture is done: a non-`media` decision plus
 *  the final text to paste (the decision's own rewrite, else the source text with
 *  the captured references spliced in). */
export interface ResolvedTextPaste {
  readonly decision: Exclude<PasteDecision, { kind: 'media' }>
  readonly text: string
}

/** Resolve a paste decision, performing MEDIA CAPTURE when the decision is `media`:
 *  capture the files via {@link captureMediaVerb} (the attachments plugin's effect —
 *  this module never imports the plugin), splice the returned `((id))` reference text
 *  into the paste, and RE-DECIDE with the files stripped so the references flow through
 *  the normal text path (landing at the caret like any pasted text, not a forced
 *  child). Surface-agnostic: the caller applies the returned decision its own way
 *  (outline insert vs editor dispatch), and reads `request.surface`/`caret` itself.
 *
 *  Returns `null` when there's nothing to paste — a capture that yielded no references
 *  AND no accompanying text, or a plugin that returned `media` with no files. A
 *  capture THROW is swallowed (a buggy plugin must not break the paste; the text
 *  half still pastes). The capture awaits, so a caller with a DETACHABLE surface (an
 *  editor view that can unmount mid-await) must re-check liveness AFTER this resolves
 *  and before applying. */
export async function resolvePasteWithMediaCapture(
  runtime: FacetRuntime,
  request: PasteRequest,
  capture: { repo: Repo; workspaceId: string },
): Promise<ResolvedTextPaste | null> {
  const decided = pasteDecisionVerb.runSync(runtime, request)
  if (decided.kind !== 'media') return { decision: decided, text: decided.text ?? request.text }

  const files = request.files ?? []
  let references: readonly string[] = []
  if (capture.workspaceId && files.length > 0) {
    try {
      references = (await captureMediaVerb.run(runtime, { repo: capture.repo, workspaceId: capture.workspaceId, files }))
        .references
    } catch (err) {
      // A buggy capture plugin must not break the paste — the text half still pastes.
      console.warn('[media] paste capture failed', err)
    }
  } else if (files.length > 0) {
    console.warn('[media] could not capture pasted file(s): no workspace')
  }

  // Clipboard text first, then one reference per captured file — each on its own line.
  const text = [request.text, ...references].filter(Boolean).join('\n')
  // Once references are spliced in, the html no longer describes the text, and
  // an html-aware override would rewrite them away. With none, it still does.
  const html = references.length > 0 ? undefined : request.html
  if (!text && !html) return null // nothing captured and nothing else to paste

  // Re-decide with files stripped + the spliced text, so the file half doesn't
  // re-trigger `media`.
  const decision = pasteDecisionVerb.runSync(runtime, { ...request, text, html, files: [] })
  if (decision.kind === 'media') return null // a plugin returned media without files — nothing to paste
  return { decision, text: decision.text ?? text }
}

/** Read the clipboard and paste it around `pasteTarget`. This is the
 *  funnel for shortcut / programmatic paste (vim normal-mode, multi-select
 *  actions) — there's no `ClipboardEvent` and no text caret.
 *
 *  Routed through `pasteDecisionVerb` (surface `shell`) so plugin overrides
 *  — text rewrites, a forced single-block, observers — apply to shortcut
 *  paste exactly as they do to the DOM block-shell paste; keeping all
 *  clipboard paste behind this one funnel stops a new call site from
 *  silently bypassing the seam. Falls back to the raw outline paste only
 *  when no runtime is installed yet (very early boot / minimal harness).
 *
 *  The clipboard API read is text-only, so `PasteRequest.html` is undefined
 *  on this surface — a format-aware override keyed on `text/html` (e.g.
 *  CSV→table from a spreadsheet copy) fires for DOM paste but not here. */
export async function pasteFromClipboard(
  pasteTarget: Block,
  repo: Repo,
  options: PasteOptions = {},
): Promise<Block[]> {
  const text = await navigator.clipboard.readText()
  if (!text) return []
  const cutPaste = await pasteArmedCut(text, pasteTarget, repo, options)
  if (cutPaste) return cutPaste.kind === 'moved' ? cutPaste.blocks : []

  const runtime = repo.facetRuntime
  if (!runtime) return pasteMultilineText(text, pasteTarget, repo, options)

  // The decision is a pure, synchronous policy (`runSync`); the clipboard text
  // is already in hand, so there's nothing to await before deciding.
  const decision = pasteDecisionVerb.runSync(runtime, {text, intent: 'split', surface: 'shell'})
  // This path is text-only (navigator.clipboard.readText carries no files), so a
  // `media` decision can't arise — fall back to the text paste if one does.
  if (decision.kind === 'media') return pasteMultilineText(text, pasteTarget, repo, options)
  return pasteResolvedDecision({decision, text: decision.text ?? text}, pasteTarget, repo, options)
}
