import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import { isCollapsedProp } from '@/data/properties.js'
import { revealChildren } from '@/data/mutators'
import { visibleChildrenOf } from '@/data/visibleChildren'
import { parseMarkdownToBlocks, singleParsedBlock, type ParsedBlock } from '@/utils/markdownParser.js'
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
  /** `visible` follows outline navigation semantics; `sibling` keeps
   *  range paste before/after the selected range unless that would
   *  leave the visible subtree. */
  placement?: PastePlacement
  /** Treat the whole clipboard text as one block's content (newlines
   *  kept) instead of parsing markdown into a tree. Used by the block-
   *  shell paste when the paste decision is `single-block`. */
  asSingleBlock?: boolean
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

const resolveRootDestination = async (
  tx: Tx,
  target: BlockData,
  {
    position,
    scopeRootId,
    placement,
  }: Required<Pick<PasteOptions, 'position' | 'placement'>> & Pick<PasteOptions, 'scopeRootId'>,
): Promise<RootDestination> => {
  const targetChildren = await visibleChildrenOf(tx, target.id, target.workspaceId)
  const targetIsScopeRoot = scopeRootId === target.id
  const targetHasVisibleChildren = targetChildren.length > 0 && !isCollapsed(target.properties)
  const rootsAsChildren = targetIsScopeRoot ||
    target.parentId === null ||
    (placement === 'visible' && position === 'after' && targetHasVisibleChildren)
  const rootParentId = rootsAsChildren ? target.id : target.parentId
  if (!rootParentId) throw new Error(`paste target ${target.id} has no visible insertion parent`)

  // Placing the pasted roots as children of `target` — reveal it if
  // collapsed so the focused paste isn't hidden inside a closed subtree
  // (same invariant as indent / moveVertical / create-child). No-op when
  // target is already expanded.
  if (rootsAsChildren) await revealChildren(tx, target.id)

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
  // A multi-line absorbed root is a fenced code block (the only parse that
  // yields one block spanning newlines). Its content is atomic — the
  // "merge only the first source line" rule would drop the code body, so
  // merge the whole block. Single-line roots keep the first-line merge
  // (strips the bullet marker, preserves leading whitespace at the cursor).
  const mergedFirstContent = absorbedRoot.content.includes('\n')
    ? absorbedRoot.content
    : editorContentForFirstPastedLine(pastedText, absorbedRoot.content)
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
    asSingleBlock = false,
  }: PasteOptions = {},
): Promise<Block[]> {
  const targetData = pasteTarget.peek() ?? await pasteTarget.load()
  if (!targetData) return []

  // Blank clipboard is a no-op on both paths: `parseMarkdownToBlocks` drops
  // all-blank input to `[]`, so `asSingleBlock` must too — otherwise it
  // would create a whitespace-only block (or clobber a blank target).
  if (asSingleBlock && isBlankContent(pastedText)) return []

  const parsed = asSingleBlock
    ? [singleParsedBlock(pastedText)]
    : parseMarkdownToBlocks(pastedText)
  if (parsed.length === 0) return []

  const parsedRoots = parsed.filter(block => !block.parentId)

  const rootBlocks: Block[] = []
  await repo.tx(async tx => {
    const target = await tx.get(pasteTarget.id)
    if (!target) return

    const destination = await resolveRootDestination(tx, target, {
      position,
      scopeRootId,
      placement,
    })

    const absorbedRoot = isBlankContent(target.content) ? parsedRoots[0] : undefined
    if (absorbedRoot) {
      await tx.update(target.id, {content: absorbedRoot.content})
      rootBlocks.push(repo.block(target.id))
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

    const destination = await resolveRootDestination(tx, target, {
      position: 'after',
      scopeRootId: options.scopeRootId,
      placement: 'sibling',
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
  if (!text) return null // nothing captured and no text

  // Re-decide with files stripped + the spliced text, so the file half doesn't
  // re-trigger `media`.
  const decision = pasteDecisionVerb.runSync(runtime, { ...request, text, files: [] })
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

  const runtime = repo.facetRuntime
  if (!runtime) return pasteMultilineText(text, pasteTarget, repo, options)

  // The decision is a pure, synchronous policy (`runSync`); the clipboard text
  // is already in hand, so there's nothing to await before deciding.
  const decision = pasteDecisionVerb.runSync(runtime, {text, intent: 'split', surface: 'shell'})
  // This path is text-only (navigator.clipboard.readText carries no files), so a
  // `media` decision can't arise — fall back to the text paste if one does.
  if (decision.kind === 'media') return pasteMultilineText(text, pasteTarget, repo, options)
  return pasteMultilineText(decision.text ?? text, pasteTarget, repo, {
    ...options,
    asSingleBlock: decision.kind === 'single-block',
  })
}
