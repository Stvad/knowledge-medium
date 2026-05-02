import type { BlockData, BlockReference } from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { parseReferences } from '@/utils/referenceParser'
import { applyHeading, collectContentRefUids, rewriteRoamContent } from './content'
import { resolveDailyPage, roamBlockId } from './ids'
import { getExtraRoamProps, type RoamBlock, type RoamExport, type RoamPage, type RoamUidRef } from './types'

export interface PreparedPage {
  /** ID of the page-level block in our system. */
  blockId: string
  roamUid: string
  /** Roam page title. */
  title: string
  /** True for daily-note pages — use getOrCreateDailyNote at write time. */
  isDaily: boolean
  /** ISO date for daily pages (e.g. "2026-04-28"). */
  iso?: string
  /**
   * For non-daily pages, the BlockData we'd create if no existing
   * block with this alias is found in the workspace. Daily pages
   * skip this — getOrCreateDailyNote owns the daily-note row.
   */
  data?: BlockData
  /** First-level child block ids (in order). The orchestrator uses
   *  this to issue tx.move calls re-parenting the descendants under
   *  the page block, since each PreparedBlock carries its own
   *  parentId derived from the planner's traversal. */
  childIds: string[]
  /** Roam attributes hoisted from `key::value` direct children of
   *  the page. For non-daily, non-merging pages these are already
   *  baked into `data.properties`; for daily / merging pages the
   *  orchestrator applies them to the live row with fill-if-missing
   *  semantics so existing values aren't clobbered. */
  promotedFromChildren: Record<string, unknown>
}

export interface PreparedBlock {
  data: BlockData
  roamUid: string
}

export interface PreparedPlaceholder {
  /** Our deterministic id for the placeholder block. */
  blockId: string
  /** The Roam uid this stands in for. */
  roamUid: string
}

export interface RoamImportPlan {
  pages: PreparedPage[]
  /** Non-page blocks, in post-order — leaves before parents within each page. */
  descendants: PreparedBlock[]
  /**
   * Empty stand-in blocks for `((uid))` references whose target wasn't in
   * this export. Created by the orchestrator so block-refs in imported
   * content resolve immediately, and so a future import that brings in
   * the real blocks upserts onto the same deterministic id.
   */
  placeholders: PreparedPlaceholder[]
  /** Roam-uid → our-uuid map (covers pages, blocks, and placeholders). */
  uidMap: Map<string, string>
  /** Aliases referenced from content (plain `[[alias]]`). Page-by-name lookup target. */
  aliasesUsed: Set<string>
  /** Per-page diagnostic notes for the summary. */
  diagnostics: string[]
}

export interface PlanOptions {
  workspaceId: string
  currentUserId: string
}

const NS_PREFIX = 'roam'

const cloneTimestamp = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const collectUidRefs = (block: RoamBlock | RoamPage): string[] => {
  const refs: RoamUidRef[] = (block.refs ?? block[':block/refs'] ?? []) as RoamUidRef[]
  return refs
    .map(ref => ref.uid ?? ref[':block/uid'])
    .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0)
}

const namespacedKey = (key: string): string => {
  // Roam keys come in two flavors: `:foo` (Datalog) and `foo` (camel).
  // Strip the leading `:` if present, then prefix our namespace.
  const cleaned = key.startsWith(':') ? key.slice(1) : key
  return `${NS_PREFIX}:${cleaned}`
}

// "Simple" Roam inline attribute: a block whose content matches
// `key:: value` (single-line, key = `[A-Za-z][\w-]*`). Multi-line
// bodies or anything that doesn't match the shape are out of scope
// for promotion and pass through untouched as plain blocks.
const SIMPLE_ATTR_RE = /^([A-Za-z][\w-]*)::\s*(.*)$/

const detectInlineAttribute = (rawContent: string | undefined): {key: string, value: string} | null => {
  if (!rawContent || rawContent.includes('\n')) return null
  const match = SIMPLE_ATTR_RE.exec(rawContent)
  if (!match) return null
  return {key: match[1], value: match[2]}
}

// `[[X]]` tokens with whitespace / `,` / `;` separators between them,
// the whole string nothing else. Used to recognise scalar property
// values that should be exploded into a list of page references —
// e.g. `isa::[[person]] [[friend]]` becomes `isa: ['[[person]]', '[[friend]]']`.
const PAGE_TOKEN_RE = /\[\[([^\]]+)\]\]/g
const PAGE_LIST_VALUE_RE = /^[\s,;]*(\[\[[^\]]+\]\][\s,;]*)+$/

const explodePageTokens = (value: string): string[] | null => {
  if (!PAGE_LIST_VALUE_RE.test(value)) return null
  const out: string[] = []
  PAGE_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PAGE_TOKEN_RE.exec(value)) !== null) out.push(`[[${m[1]}]]`)
  // Single token: not really a "list", let the caller keep the scalar.
  if (out.length < 2) return null
  return out
}

/**
 * Promotion result for a parent block's direct children.
 *
 *   - `promoted` is the namespaced property bag to merge onto the
 *     parent. Single-value entries are scalars; multi-value entries
 *     are arrays (case 2: same-key siblings, case 4: list-children of
 *     an attr block).
 *   - `droppedDirect` lists direct-child uids that were fully consumed
 *     (standalone attrs, or attr blocks whose entire subtree bubbled).
 *   - `effectiveChildren` per-uid overrides the children list of a
 *     kept attr block — sub-attr children that bubbled up are removed,
 *     non-attr children stay.
 *   - `diagnostics` surfaces unusual structures (e.g. attr nesting
 *     deeper than two levels) so the post-import log can flag them.
 */
interface PromotionResult {
  promoted: Record<string, unknown>
  droppedDirect: Set<string>
  effectiveChildren: Map<string, RoamBlock[]>
  diagnostics: string[]
  /** Uids of blocks whose values were pulled into `promoted` (directly
   *  or via the recursive bubble-up). Tracked so a deeper promotion
   *  pass can skip them and avoid re-bubbling onto intermediate blocks
   *  along an `attr → attr` chain. */
  bubbled: Set<string>
}

/** Walk a parent's direct children and compute case-1/2/3/4 promotion.
 *  See `PromotionResult` for the output shape.
 *
 *  `alreadyBubbled` is a set of uids whose values were already pulled
 *  up by an ancestor's promotion pass. The page-level pass bubbles
 *  attrs through unbroken `attr → attr` chains all the way up; without
 *  this guard, the recursive buildBlock-time promotion of an
 *  intermediate kept attr block would re-bubble the same descendants
 *  onto itself and produce duplicate property entries on every block
 *  along the chain. */
const computePromotedFromChildren = (
  children: ReadonlyArray<RoamBlock>,
  alreadyBubbled: ReadonlySet<string>,
): PromotionResult => {
  const accumulator = new Map<string, unknown[]>()
  const droppedDirect = new Set<string>()
  const effectiveChildren = new Map<string, RoamBlock[]>()
  const diagnostics: string[] = []
  const newlyBubbled = new Set<string>()

  const push = (key: string, value: unknown) => {
    const propName = `${NS_PREFIX}:${key}`
    const list = accumulator.get(propName) ?? []
    list.push(value)
    accumulator.set(propName, list)
  }

  // Returns true when `block` is fully consumed and can be dropped
  // from the tree. `depth` is the bubbling distance from the original
  // parent (0 = direct child of parent).
  const consume = (block: RoamBlock, depth: number): boolean => {
    if (alreadyBubbled.has(block.uid) || newlyBubbled.has(block.uid)) return false
    const attr = detectInlineAttribute(block.string)
    if (!attr) return false

    if (depth >= 2) {
      diagnostics.push(
        `Attribute "${attr.key}" hoisted from depth ${depth + 1} (uid ${block.uid}) — ` +
        `unusual nesting; review the source structure.`,
      )
    }

    newlyBubbled.add(block.uid)
    if (attr.value.trim() !== '') push(attr.key, attr.value)

    const subs = block.children ?? []
    if (subs.length === 0) return true

    const kept: RoamBlock[] = []
    for (const sub of subs) {
      if (detectInlineAttribute(sub.string)) {
        // Sub-attr: try to bubble it up to the original parent.
        const consumed = consume(sub, depth + 1)
        if (!consumed) kept.push(sub)
      } else {
        // Non-attr sub-bullet: contributes its raw string as another
        // value for the enclosing attr's key (case 4). Block stays as
        // a descendant so the tree shape is preserved alongside the
        // queryable property.
        push(attr.key, sub.string ?? '')
        kept.push(sub)
      }
    }

    if (kept.length === 0) return true
    if (kept.length < subs.length) effectiveChildren.set(block.uid, kept)
    return false
  }

  for (const child of children) {
    if (!detectInlineAttribute(child.string)) continue
    if (consume(child, 0)) droppedDirect.add(child.uid)
  }

  // Finalize: scalar for length-1, list for length>1, then post-process
  // any scalar that's a sequence of `[[X]]` tokens into a page list (case 3).
  const promoted: Record<string, unknown> = {}
  for (const [key, values] of accumulator) {
    if (values.length === 1) {
      const single = values[0]
      if (typeof single === 'string') {
        const exploded = explodePageTokens(single)
        promoted[key] = exploded ?? single
      } else {
        promoted[key] = single
      }
    } else {
      // Multi-value: keep each string item but flatten any page-token
      // strings so a mix like ['[[a]] [[b]]', '[[c]]'] becomes
      // ['[[a]]', '[[b]]', '[[c]]'].
      const flat: unknown[] = []
      for (const v of values) {
        if (typeof v === 'string') {
          const exploded = explodePageTokens(v)
          if (exploded) flat.push(...exploded)
          else flat.push(v)
        } else {
          flat.push(v)
        }
      }
      promoted[key] = flat
    }
  }

  return {promoted, droppedDirect, effectiveChildren, diagnostics, bubbled: newlyBubbled}
}

// Collect every `[[X]]` token nested inside a property value. Used to
// register page-link targets from property values into ctx.aliasesUsed
// so the seat-creation pipeline materialises them just like content
// references would, AND by the post-resolution patcher so a dropped
// attribute like `author::[[stvad]]` survives as a backlink edge after
// the surviving block writes.
export const collectAliasesFromPropertyValues = (
  promoted: Record<string, unknown>,
): string[] => {
  const out = new Set<string>()
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      PAGE_TOKEN_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = PAGE_TOKEN_RE.exec(v)) !== null) out.add(m[1])
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item)
    }
  }
  for (const v of Object.values(promoted)) visit(v)
  return [...out]
}

const collectRoamProps = (block: RoamBlock | RoamPage): Record<string, unknown> => {
  const fromBlockProps = (block[':block/props'] ?? block.props ?? {}) as Record<string, unknown>
  return {...fromBlockProps, ...getExtraRoamProps(block)}
}

/** Translate Roam's property bag into the new flat-property shape:
 *  values are stored encoded directly under their (namespaced) key.
 *  Numbers stay numbers, strings stay strings, structured values are
 *  JSON-stringified for round-trip. The Roam namespace prefix
 *  (`roam:`) keeps these from colliding with kernel properties. */
const propertiesFromRoam = (
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(raw)) {
    const propName = namespacedKey(key)
    if (typeof value === 'number') {
      out[propName] = value
    } else if (typeof value === 'string') {
      out[propName] = value
    } else if (value !== null && value !== undefined) {
      // Object/array values: stringify so the data round-trips;
      // a follow-up can promote structured values once we have
      // more known shapes.
      out[propName] = JSON.stringify(value)
    }
  }

  return out
}

interface BuildContext {
  options: PlanOptions
  uidMap: Map<string, string>
  aliasesUsed: Set<string>
  unresolvedBlockUids: Set<string>
  diagnostics: string[]
  /** Per-uid override of `block.children`. When a kept attr block has
   *  some of its sub-attr children bubbled to its parent, the bubbled
   *  ones disappear from this list — `buildBlock` reads from the
   *  override so the recursion doesn't re-process bubbled grandchildren
   *  (which would double-promote them). */
  effectiveChildren: Map<string, RoamBlock[]>
  /** Uids whose values were already pulled into a higher-level block's
   *  promoted properties. `computePromotedFromChildren` skips children
   *  whose uid is in this set so kept intermediate attr blocks (along
   *  an `attr → attr` chain) don't re-bubble the same descendants. */
  bubbledUids: Set<string>
}

const childrenOf = (ctx: BuildContext, block: RoamBlock): RoamBlock[] =>
  ctx.effectiveChildren.get(block.uid) ?? block.children ?? []

const buildBlock = (
  ctx: BuildContext,
  block: RoamBlock,
  parentId: string,
  siblingIndex: number,
  pushDescendant: (b: PreparedBlock) => void,
): string => {
  const id = ctx.uidMap.get(block.uid)
  if (!id) throw new Error(`Roam uid not in uidMap: ${block.uid}`)

  const children = childrenOf(ctx, block)
  const promotion = computePromotedFromChildren(children, ctx.bubbledUids)
  for (const d of promotion.diagnostics) ctx.diagnostics.push(d)
  for (const [uid, kept] of promotion.effectiveChildren) {
    ctx.effectiveChildren.set(uid, kept)
  }
  for (const uid of promotion.bubbled) ctx.bubbledUids.add(uid)

  // Use the original index for the order key so skipped attribute
  // blocks just leave a gap rather than reshuffling siblings.
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (promotion.droppedDirect.has(child.uid)) continue
    buildBlock(ctx, child, id, i, pushDescendant)
  }

  const data = composeBlockData({
    ctx,
    id,
    parentId,
    orderKey: siblingOrderKey(siblingIndex),
    rawString: block.string ?? '',
    heading: block.heading,
    roamProps: collectRoamProps(block),
    roamRefUids: collectUidRefs(block),
    createdAt: cloneTimestamp(block['create-time'], Date.now()),
    updatedAt: cloneTimestamp(block['edit-time'] ?? block['create-time'], Date.now()),
    promotedFromChildren: promotion.promoted,
  })

  pushDescendant({data, roamUid: block.uid})
  return id
}

/** Deterministic order key from a sibling index. The Roam children
 *  array IS the order, so a simple `a${index}` chain preserves it.
 *  Same import twice → same keys → upserts onto the same rows.
 *  (Not a fractional-indexing-jittered key, but inserting between
 *  imports isn't a workflow we support — re-importing replaces. */
const siblingOrderKey = (index: number): string => `a${index.toString().padStart(6, '0')}`

interface ComposeArgs {
  ctx: BuildContext
  id: string
  parentId: string | null
  orderKey: string
  rawString: string
  heading?: number
  roamProps: Record<string, unknown>
  roamRefUids: string[]
  createdAt: number
  updatedAt: number
  extraProperties?: Record<string, unknown>
  /** Roam `key::value` children of this block, hoisted onto its
   *  properties. Lower precedence than `roamProps` and
   *  `extraProperties` so an explicit value on the block itself
   *  isn't clobbered. */
  promotedFromChildren?: Record<string, unknown>
}

const composeBlockData = (args: ComposeArgs): BlockData => {
  const {ctx, id, parentId, orderKey, rawString, heading, roamProps, roamRefUids, createdAt, updatedAt, extraProperties, promotedFromChildren} = args

  const rewritten = rewriteRoamContent(rawString, ctx.uidMap)
  for (const u of rewritten.unresolvedBlockUids) ctx.unresolvedBlockUids.add(u)

  const content = applyHeading(rewritten.content, heading)

  // Collect aliases referenced from this block. Used by the orchestrator
  // to pre-resolve alias targets before the import lands.
  const aliasMatches = parseReferences(content)
  for (const ref of aliasMatches) ctx.aliasesUsed.add(ref.alias)

  // Pre-populate references[] with what we can resolve right now: page
  // aliases (id is filled in later by the orchestrator) and block-ref
  // uids (already mapped). The orchestrator finishes the alias rows.
  const blockRefs: BlockReference[] = roamRefUids
    .map(roamUid => ctx.uidMap.get(roamUid))
    .filter((mapped): mapped is string => Boolean(mapped))
    .map(mapped => ({id: mapped, alias: mapped}))

  const properties: Record<string, unknown> = {
    ...(promotedFromChildren ?? {}),
    ...propertiesFromRoam(roamProps),
    ...(extraProperties ?? {}),
  }

  // Property values can carry `[[X]]` page tokens (case 3 explosion or
  // hoisted-as-string values like `author::[[stvad]]`). Register those
  // aliases so the orchestrator's seat-creation pipeline materialises
  // their target rows just like content references would.
  for (const alias of collectAliasesFromPropertyValues(properties)) {
    ctx.aliasesUsed.add(alias)
  }

  const data: BlockData = {
    id,
    workspaceId: ctx.options.workspaceId,
    parentId,
    orderKey,
    content,
    properties,
    references: blockRefs,
    createdAt,
    updatedAt,
    createdBy: ctx.options.currentUserId,
    updatedBy: ctx.options.currentUserId,
    deleted: false,
  }

  return data
}

const buildUidMap = (
  pages: RoamExport,
  workspaceId: string,
): {
  uidMap: Map<string, string>,
  dailyByUid: Map<string, {iso: string, blockId: string}>,
  knownUids: Set<string>,
} => {
  const uidMap = new Map<string, string>()
  const dailyByUid = new Map<string, {iso: string, blockId: string}>()
  const knownUids = new Set<string>()

  const visit = (block: RoamBlock) => {
    knownUids.add(block.uid)
    if (!uidMap.has(block.uid)) {
      uidMap.set(block.uid, roamBlockId(workspaceId, block.uid))
    }
    for (const child of block.children ?? []) visit(child)
  }

  for (const page of pages) {
    knownUids.add(page.uid)
    const daily = resolveDailyPage(workspaceId, page)
    if (daily) {
      dailyByUid.set(page.uid, daily)
      uidMap.set(page.uid, daily.blockId)
    } else {
      uidMap.set(page.uid, roamBlockId(workspaceId, page.uid))
    }
    for (const child of page.children ?? []) visit(child)
  }

  return {uidMap, dailyByUid, knownUids}
}

// Walk all `string` fields in the export and surface every `((uid))` /
// embed reference. The planner registers any uid that wasn't already in
// the export's block tree as a placeholder so content rewrites resolve
// against deterministic ids and a later, more-complete import upserts
// onto the same rows.
const collectPlaceholderUids = (
  pages: RoamExport,
  knownUids: Set<string>,
): string[] => {
  const out = new Set<string>()
  const visit = (block: RoamBlock) => {
    for (const uid of collectContentRefUids(block.string ?? '')) {
      if (!knownUids.has(uid)) out.add(uid)
    }
    for (const child of block.children ?? []) visit(child)
  }
  for (const page of pages) {
    for (const child of page.children ?? []) visit(child)
  }
  return [...out]
}

export const planImport = (pages: RoamExport, options: PlanOptions): RoamImportPlan => {
  const {uidMap, dailyByUid, knownUids} = buildUidMap(pages, options.workspaceId)

  const placeholderUids = collectPlaceholderUids(pages, knownUids)
  const placeholders: PreparedPlaceholder[] = placeholderUids.map(roamUid => {
    const blockId = roamBlockId(options.workspaceId, roamUid)
    uidMap.set(roamUid, blockId)
    return {blockId, roamUid}
  })

  const diagnostics: string[] = []
  const ctx: BuildContext = {
    options,
    uidMap,
    aliasesUsed: new Set(),
    unresolvedBlockUids: new Set(),
    diagnostics,
    effectiveChildren: new Map(),
    bubbledUids: new Set(),
  }

  const preparedPages: PreparedPage[] = []
  const descendants: PreparedBlock[] = []

  const pushDescendant = (b: PreparedBlock) => descendants.push(b)

  for (const page of pages) {
    const daily = dailyByUid.get(page.uid)
    const pageBlockId = uidMap.get(page.uid)
    if (!pageBlockId) throw new Error(`Page uid not in uidMap: ${page.uid}`)

    const childIds: string[] = []
    const pageChildren = page.children ?? []
    const pagePromotion = computePromotedFromChildren(pageChildren, ctx.bubbledUids)
    for (const d of pagePromotion.diagnostics) diagnostics.push(d)
    for (const [uid, kept] of pagePromotion.effectiveChildren) {
      ctx.effectiveChildren.set(uid, kept)
    }
    for (const uid of pagePromotion.bubbled) ctx.bubbledUids.add(uid)
    for (let i = 0; i < pageChildren.length; i++) {
      const child = pageChildren[i]
      if (pagePromotion.droppedDirect.has(child.uid)) continue
      childIds.push(buildBlock(ctx, child, pageBlockId, i, pushDescendant))
    }
    const promotedFromChildren = pagePromotion.promoted

    if (daily) {
      preparedPages.push({
        blockId: pageBlockId,
        roamUid: page.uid,
        title: page.title,
        isDaily: true,
        iso: daily.iso,
        childIds,
        promotedFromChildren,
      })
      continue
    }

    // Non-daily top-level page: build the page block. The orchestrator
    // will check for an existing block with this alias before deciding
    // to create vs merge. Pages are root blocks (parentId=null) with
    // a starter order key — top-level workspace ordering isn't
    // import-controlled.
    const pageData = composeBlockData({
      ctx,
      id: pageBlockId,
      parentId: null,
      orderKey: 'a0',
      rawString: page.title,
      heading: undefined,
      roamProps: collectRoamProps(page),
      roamRefUids: collectUidRefs(page),
      createdAt: cloneTimestamp(page['create-time'], Date.now()),
      updatedAt: cloneTimestamp(page['edit-time'] ?? page['create-time'], Date.now()),
      extraProperties: {
        [aliasesProp.name]: aliasesProp.codec.encode([page.title]),
        [typeProp.name]: typeProp.codec.encode('page'),
      },
      promotedFromChildren,
    })

    preparedPages.push({
      blockId: pageBlockId,
      roamUid: page.uid,
      title: page.title,
      isDaily: false,
      data: pageData,
      childIds,
      promotedFromChildren,
    })
  }

  if (placeholders.length > 0) {
    diagnostics.push(
      `${placeholders.length} block-ref uid(s) not present in this export — created as empty placeholder blocks; a future import that includes them will upsert onto the same deterministic ids.`,
    )
  }

  // Defense-in-depth: every uid in content should now resolve via uidMap.
  // If anything still leaks through it's a planner bug — surface it loudly.
  if (ctx.unresolvedBlockUids.size > 0) {
    diagnostics.push(
      `[bug] ${ctx.unresolvedBlockUids.size} content uid(s) leaked past placeholder registration: ${[...ctx.unresolvedBlockUids].slice(0, 5).join(', ')}`,
    )
  }

  return {
    pages: preparedPages,
    descendants,
    placeholders,
    uidMap,
    aliasesUsed: ctx.aliasesUsed,
    diagnostics,
  }
}
