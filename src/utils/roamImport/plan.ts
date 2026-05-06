import type { BlockData, BlockReference } from '@/data/api'
import { addBlockTypeToProperties, aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { srsNextReviewDateProp } from '@/plugins/srs-rescheduling/schema'
import type { RoamTodoState } from '@/plugins/todo/schema'
import { applyHeading, collectContentRefUids, rewriteRoamContent } from './content'
import { resolveDailyPage, roamBlockId } from './ids'
import { getExtraRoamProps, type RoamBlock, type RoamExport, type RoamPage, type RoamUidRef } from './types'
import {
  collectAliasesFromPropertyValues,
  collectPageAliases,
  derivePropertiesFromContent,
  propertiesFromRoam,
  uniqueStrings,
} from './properties'
import { computePromotedFromChildren } from './promotion'
import {
  collectRoamMemoEntries,
  propertiesFromRoamMemo,
  srsSourceConflictDiagnostics,
  type PreparedRoamMemoEntry,
  type RoamMemoImportPlanSummary,
} from './roamMemo'
import {
  findSrsScheduleInChildren,
  propertiesFromSrsSchedule,
  type PreparedSrsSchedule,
} from './srsMarkers'
import { parseRoamImportReferences } from './references'
import { extractRoamTodoMarker } from './todo'

export {
  ROAM_AUTHOR_PROP,
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
  normalizeRoamPropertyValue,
} from './properties'
export {
  computePromotedFromChildren,
  type PromotionOptions,
  type PromotionResult,
} from './promotion'
export {
  type PreparedRoamMemoEntry,
  type PreparedRoamMemoSnapshot,
  type RoamMemoImportPlanSummary,
} from './roamMemo'
export {
  extractSrsScheduleMarker,
  type PreparedSrsSchedule,
} from './srsMarkers'
export { parseRoamImportReferences } from './references'
export { extractRoamTodoMarker } from './todo'

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
  /** Page aliases declared through Roam's page_alias::[[Other Page]]
   *  convention. These are applied to the page's canonical alias list
   *  and used by the importer to merge duplicate exported pages. */
  pageAliases: string[]
}

export interface PreparedBlock {
  data: BlockData
  roamUid: string
  todoState?: RoamTodoState
  srsSchedule?: PreparedSrsSchedule
  roamMemo?: PreparedRoamMemoEntry
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
  roamMemo: RoamMemoImportPlanSummary
}

export interface PlanOptions {
  workspaceId: string
  currentUserId: string
}

const cloneTimestamp = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const collectUidRefs = (block: RoamBlock | RoamPage): string[] => {
  const refs: RoamUidRef[] = (block.refs ?? block[':block/refs'] ?? []) as RoamUidRef[]
  return refs
    .map(ref => ref.uid ?? ref[':block/uid'])
    .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0)
}

const collectRoamProps = (block: RoamBlock | RoamPage): Record<string, unknown> => {
  const fromBlockProps = (block[':block/props'] ?? block.props ?? {}) as Record<string, unknown>
  return {...fromBlockProps, ...getExtraRoamProps(block)}
}

interface BuildContext {
  options: PlanOptions
  uidMap: Map<string, string>
  roamMemoByTargetUid: Map<string, PreparedRoamMemoEntry>
  aliasesUsed: Set<string>
  unresolvedBlockUids: Set<string>
  diagnostics: string[]
  /** Uids whose values were already pulled into a higher-level block's
   *  promoted properties. `computePromotedFromChildren` skips children
   *  whose uid is in this set so an intermediate attr block on the
   *  bubble chain doesn't re-promote the same descendants when
   *  buildBlock recurses into it. */
  bubbledUids: Set<string>
}

const buildBlock = (
  ctx: BuildContext,
  block: RoamBlock,
  parentId: string,
  siblingIndex: number,
  pushDescendant: (b: PreparedBlock) => void,
): string => {
  const id = ctx.uidMap.get(block.uid)
  if (!id) throw new Error(`Roam uid not in uidMap: ${block.uid}`)

  const children = block.children ?? []
  const promotion = computePromotedFromChildren(children, ctx.bubbledUids)
  const srsSchedule = findSrsScheduleInChildren(children, ctx.options.workspaceId)
  const roamMemo = ctx.roamMemoByTargetUid.get(block.uid)
  for (const d of promotion.diagnostics) ctx.diagnostics.push(d)
  for (const d of srsSourceConflictDiagnostics(block.uid, srsSchedule, roamMemo)) {
    ctx.diagnostics.push(d)
  }
  for (const uid of promotion.bubbled) ctx.bubbledUids.add(uid)
  if (srsSchedule) ctx.aliasesUsed.add(srsSchedule.nextReviewDateAlias)
  if (roamMemo) {
    for (const snapshot of roamMemo.snapshots) ctx.aliasesUsed.add(snapshot.reviewedAtAlias)
    const latest = roamMemo.snapshots.at(-1)
    if (latest) ctx.aliasesUsed.add(latest.nextReviewDateAlias)
  }

  // Every original block is preserved in the tree; the importer no
  // longer drops attribute blocks on promotion. Backlinks come through
  // each block's own content (parseReferences sees `[[X]]` in
  // `author::[[X]]` and writes a references[] row) and properties get
  // hoisted as queryable mirrors.
  for (let i = 0; i < children.length; i++) {
    buildBlock(ctx, children[i], id, i, pushDescendant)
  }

  const todo = extractRoamTodoMarker(block.string ?? '')
  const data = composeBlockData({
    ctx,
    id,
    parentId,
    orderKey: siblingOrderKey(siblingIndex),
    rawString: todo.content,
    heading: block.heading,
    roamProps: collectRoamProps(block),
    roamRefUids: collectUidRefs(block),
    createdAt: cloneTimestamp(block['create-time'], Date.now()),
    updatedAt: cloneTimestamp(block['edit-time'] ?? block['create-time'], Date.now()),
    promotedFromChildren: {
      ...promotion.promoted,
      ...propertiesFromSrsSchedule(srsSchedule),
      ...propertiesFromRoamMemo(roamMemo),
    },
  })

  if (srsSchedule) {
    data.references.push({
      id: srsSchedule.nextReviewDateId,
      alias: srsSchedule.nextReviewDateAlias,
      sourceField: srsNextReviewDateProp.name,
    })
  }
  const latestMemoSnapshot = roamMemo?.snapshots.at(-1)
  if (latestMemoSnapshot) {
    data.references.push({
      id: latestMemoSnapshot.nextReviewDateId,
      alias: latestMemoSnapshot.nextReviewDateAlias,
      sourceField: srsNextReviewDateProp.name,
    })
  }

  pushDescendant({data, roamUid: block.uid, todoState: todo.todoState, srsSchedule, roamMemo})
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
  const aliasMatches = parseRoamImportReferences(content)
  for (const ref of aliasMatches) ctx.aliasesUsed.add(ref.alias)

  // Pre-populate references[] with what we can resolve right now: page
  // aliases (id is filled in later by the orchestrator) and block-ref
  // uids (already mapped). The orchestrator finishes the alias rows.
  const blockRefs: BlockReference[] = roamRefUids
    .map(roamUid => ctx.uidMap.get(roamUid))
    .filter((mapped): mapped is string => Boolean(mapped))
    .map(mapped => ({id: mapped, alias: mapped}))

  const properties: Record<string, unknown> = {
    ...derivePropertiesFromContent(content),
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
  const roamMemo = collectRoamMemoEntries(pages, knownUids, options.workspaceId)

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
    roamMemoByTargetUid: roamMemo.byTargetUid,
    aliasesUsed: new Set(),
    unresolvedBlockUids: new Set(),
    diagnostics,
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
    for (const uid of pagePromotion.bubbled) ctx.bubbledUids.add(uid)
    for (let i = 0; i < pageChildren.length; i++) {
      childIds.push(buildBlock(ctx, pageChildren[i], pageBlockId, i, pushDescendant))
    }
    const promotedFromChildren = pagePromotion.promoted
    const pageRoamProps = collectRoamProps(page)
    const pageAliases = collectPageAliases({
      ...promotedFromChildren,
      ...propertiesFromRoam(pageRoamProps),
    })

    if (daily) {
      preparedPages.push({
        blockId: pageBlockId,
        roamUid: page.uid,
        title: page.title,
        isDaily: true,
        iso: daily.iso,
        childIds,
        promotedFromChildren,
        pageAliases,
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
      roamProps: pageRoamProps,
      roamRefUids: collectUidRefs(page),
      createdAt: cloneTimestamp(page['create-time'], Date.now()),
      updatedAt: cloneTimestamp(page['edit-time'] ?? page['create-time'], Date.now()),
      extraProperties: addBlockTypeToProperties({
        [aliasesProp.name]: aliasesProp.codec.encode(uniqueStrings([page.title, ...pageAliases])),
      }, PAGE_TYPE),
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
      pageAliases,
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
    roamMemo: roamMemo.summary,
  }
}
