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
  nonStandardPageAliasValues,
  propertiesFromRoam,
  ROAM_AUTHOR_PROP,
  ROAM_EMBED_PATH_PROP,
  ROAM_MESSAGE_AUTHOR_PROP,
  ROAM_MESSAGE_TIMESTAMP_PROP,
  ROAM_MESSAGE_URL_PROP,
  ROAM_TIMESTAMP_PROP,
  ROAM_URL_PROP,
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
  extractSrsScheduleMarker,
  findPromotedSrsScheduleInChildren,
  hasSrsScheduleDate,
  hasSrsScheduleFields,
  isSrsScheduleMarkerOnly,
  propertiesFromSrsSchedule,
  type PreparedSrsSchedule,
} from './srsMarkers'
import { parseRoamImportReferences } from './references'
import { extractRoamTodoMarker } from './todo'

export {
  ROAM_AUTHOR_PROP,
  ROAM_EMBED_PATH_PROP,
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
  const fromBlockProps = {...((block[':block/props'] ?? block.props ?? {}) as Record<string, unknown>)}
  if (block[':children/view-type']) {
    fromBlockProps[':children/view-type'] = block[':children/view-type']
  }
  if (block[':block/view-type']) {
    fromBlockProps[':block/view-type'] = block[':block/view-type']
  }
  return {...fromBlockProps, ...getExtraRoamProps(block)}
}

interface BuildContext {
  options: PlanOptions
  uidMap: Map<string, string>
  roamMemoByTargetUid: Map<string, PreparedRoamMemoEntry>
  aliasesUsed: Set<string>
  unresolvedBlockUids: Set<string>
  diagnostics: string[]
  emittedBlockUids: Set<string>
  readwisePromotedMetadataConflictCounts: Map<string, number>
  readwisePromotedMetadataConflictSamples: string[]
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
  const alreadyEmitted = ctx.emittedBlockUids.has(block.uid)
  if (alreadyEmitted) {
    for (let i = 0; i < children.length; i++) {
      buildBlock(ctx, children[i], id, i, pushDescendant)
    }
    return id
  }
  ctx.emittedBlockUids.add(block.uid)

  const promotion = computePromotedFromChildren(children, ctx.bubbledUids)
  const promotedSrs = findPromotedSrsScheduleInChildren(children, ctx.options.workspaceId, block.uid)
  const rawContent = block.string ?? ''
  const ownSrsSchedule = extractSrsScheduleMarker(rawContent, ctx.options.workspaceId)
  if (!ownSrsSchedule && hasSrsScheduleFields(rawContent) && !hasSrsScheduleDate(rawContent)) {
    ctx.diagnostics.push(
      `Roam SRS marker on uid ${block.uid} has interval/factor but no parseable daily review date; ` +
      `preserved literally without SRS properties.`,
    )
  }
  const ownSrsApplies = ownSrsSchedule !== null && !isSrsScheduleMarkerOnly(rawContent)
  const srsSchedule = ownSrsApplies ? ownSrsSchedule : promotedSrs.schedule
  const roamMemo = ctx.roamMemoByTargetUid.get(block.uid)
  for (const d of promotion.diagnostics) ctx.diagnostics.push(d)
  for (const d of promotedSrs.diagnostics) ctx.diagnostics.push(d)
  if (ownSrsApplies && promotedSrs.schedule) {
    ctx.diagnostics.push(
      `Roam SRS marker conflict on uid ${block.uid}: block has embedded SRS metadata and ` +
      `marker-only child metadata; applied the embedded block metadata.`,
    )
  }
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
    roamUid: block.uid,
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
  roamUid: string
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

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

const propertyValues = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value]

const propertyKey = (value: unknown): string =>
  typeof value === 'string' ? `s:${value.trim()}` : JSON.stringify(value)

const mergePropertyValues = (primary: unknown, secondary: unknown): unknown => {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const value of [...propertyValues(primary), ...propertyValues(secondary)]) {
    const key = propertyKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(typeof value === 'string' ? value.trim() : value)
  }
  return out.length === 1 ? out[0] : out
}

const propertyValuesEqual = (a: unknown, b: unknown): boolean => {
  const left = propertyValues(a).map(propertyKey).sort()
  const right = propertyValues(b).map(propertyKey).sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const valuesNotIn = (values: unknown, existing: unknown): unknown[] => {
  const existingKeys = new Set(propertyValues(existing).map(propertyKey))
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const value of propertyValues(values)) {
    const key = propertyKey(value)
    if (existingKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(typeof value === 'string' ? value.trim() : value)
  }
  return out
}

const propertyValueFromList = (values: readonly unknown[]): unknown =>
  values.length === 1 ? values[0] : [...values]

const matrixUrlValues = (value: unknown): unknown[] =>
  propertyValues(value).filter(item =>
    typeof item === 'string' && /^https:\/\/matrix\.to\//i.test(item.trim()),
  )

interface ReconciledPromotedProperties {
  derivedProperties: Record<string, unknown>
  promotedProperties: Record<string, unknown>
  preservedProperties: Record<string, unknown>
}

const reconcileReadwisePromotedMetadata = (
  roamUid: string,
  derived: Record<string, unknown>,
  promoted: Record<string, unknown> | undefined,
  ctx: BuildContext,
): ReconciledPromotedProperties => {
  const derivedProperties = {...derived}
  const promotedProperties = {...(promoted ?? {})}
  const preservedProperties: Record<string, unknown> = {}

  const hasDerivedArticleMetadata =
    hasOwn(derivedProperties, ROAM_AUTHOR_PROP) ||
    hasOwn(derivedProperties, ROAM_URL_PROP)
  if (!hasDerivedArticleMetadata) {
    return {derivedProperties, promotedProperties, preservedProperties}
  }

  const notes: string[] = []
  if (hasOwn(promotedProperties, ROAM_URL_PROP)) {
    const promotedUrl = promotedProperties[ROAM_URL_PROP]
    const matrixUrls = matrixUrlValues(promotedUrl)
    if (matrixUrls.length > 0) {
      preservedProperties[ROAM_MESSAGE_URL_PROP] = propertyValueFromList(matrixUrls)
      notes.push(`preserved Matrix URL as ${ROAM_MESSAGE_URL_PROP}`)
    }
    if (hasOwn(derivedProperties, ROAM_URL_PROP)) {
      const promotedOnly = valuesNotIn(promotedUrl, derivedProperties[ROAM_URL_PROP])
      if (promotedOnly.length > 0) {
        derivedProperties[ROAM_URL_PROP] = mergePropertyValues(
          derivedProperties[ROAM_URL_PROP],
          promotedUrl,
        )
        notes.push(`merged promoted ${ROAM_URL_PROP} into derived ${ROAM_URL_PROP}`)
      }
      delete promotedProperties[ROAM_URL_PROP]
    }
  }

  let movedMessageMetadata = hasOwn(preservedProperties, ROAM_MESSAGE_URL_PROP)
  if (hasOwn(promotedProperties, ROAM_AUTHOR_PROP)) {
    const promotedAuthor = promotedProperties[ROAM_AUTHOR_PROP]
    if (!hasOwn(derivedProperties, ROAM_AUTHOR_PROP) ||
        !propertyValuesEqual(derivedProperties[ROAM_AUTHOR_PROP], promotedAuthor)) {
      preservedProperties[ROAM_MESSAGE_AUTHOR_PROP] = promotedAuthor
      notes.push(`preserved promoted ${ROAM_AUTHOR_PROP} as ${ROAM_MESSAGE_AUTHOR_PROP}`)
      movedMessageMetadata = true
    }
    delete promotedProperties[ROAM_AUTHOR_PROP]
  }

  if (movedMessageMetadata && hasOwn(promotedProperties, ROAM_TIMESTAMP_PROP)) {
    preservedProperties[ROAM_MESSAGE_TIMESTAMP_PROP] = promotedProperties[ROAM_TIMESTAMP_PROP]
    delete promotedProperties[ROAM_TIMESTAMP_PROP]
    notes.push(`preserved promoted ${ROAM_TIMESTAMP_PROP} as ${ROAM_MESSAGE_TIMESTAMP_PROP}`)
  }

  if (notes.length > 0) {
    for (const note of notes) {
      ctx.readwisePromotedMetadataConflictCounts.set(
        note,
        (ctx.readwisePromotedMetadataConflictCounts.get(note) ?? 0) + 1,
      )
    }
    if (ctx.readwisePromotedMetadataConflictSamples.length < 8) {
      ctx.readwisePromotedMetadataConflictSamples.push(`uid ${roamUid}: ${notes.join('; ')}`)
    }
  }

  return {derivedProperties, promotedProperties, preservedProperties}
}

const composeBlockData = (args: ComposeArgs): BlockData => {
  const {ctx, id, roamUid, parentId, orderKey, rawString, heading, roamProps, roamRefUids, createdAt, updatedAt, extraProperties, promotedFromChildren} = args

  const rewritten = rewriteRoamContent(rawString, ctx.uidMap)
  for (const u of rewritten.unresolvedBlockUids) ctx.unresolvedBlockUids.add(u)

  const derived = derivePropertiesFromContent(rewritten.content)
  for (const diagnostic of derived.diagnostics) {
    ctx.diagnostics.push(`Readwise property extraction on uid ${roamUid}: ${diagnostic}`)
  }

  const content = applyHeading(derived.content, heading)

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

  const reconciled = reconcileReadwisePromotedMetadata(
    roamUid,
    derived.properties,
    promotedFromChildren,
    ctx,
  )
  const properties: Record<string, unknown> = {
    ...reconciled.derivedProperties,
    ...reconciled.promotedProperties,
    ...reconciled.preservedProperties,
    ...propertiesFromRoam(roamProps),
    ...(extraProperties ?? {}),
  }
  if (rewritten.embedPathTargets.length > 0 && properties[ROAM_EMBED_PATH_PROP] === undefined) {
    const targets = uniqueStrings(rewritten.embedPathTargets)
    properties[ROAM_EMBED_PATH_PROP] = targets.length === 1 ? targets[0] : targets
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

interface UidOccurrence {
  uid: string
  kind: 'page' | 'block'
  pageTitle: string
  parentUid: string | null
  siblingIndex: number
  content: string
  childUids: string[]
}

const occurrenceContent = (occ: UidOccurrence): string =>
  occ.content.replace(/\s+/g, ' ').trim()

const occurrenceParent = (occ: UidOccurrence): string =>
  occ.kind === 'page'
    ? '(page)'
    : `${occ.pageTitle}\u0000${occ.parentUid ?? '(page-root)'}`

const occurrenceChildren = (occ: UidOccurrence): string =>
  occ.childUids.join('\u0000')

const quotedSample = (value: string): string => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const clipped = normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
  return JSON.stringify(clipped)
}

const collectDuplicateUidDiagnostics = (pages: RoamExport): string[] => {
  const occurrences = new Map<string, UidOccurrence[]>()
  const add = (occ: UidOccurrence) => {
    const list = occurrences.get(occ.uid) ?? []
    list.push(occ)
    occurrences.set(occ.uid, list)
  }

  const visitBlock = (
    block: RoamBlock,
    pageTitle: string,
    parentUid: string | null,
    siblingIndex: number,
  ) => {
    add({
      uid: block.uid,
      kind: 'block',
      pageTitle,
      parentUid,
      siblingIndex,
      content: block.string ?? '',
      childUids: (block.children ?? []).map(child => child.uid),
    })
    for (let i = 0; i < (block.children ?? []).length; i++) {
      visitBlock(block.children![i], pageTitle, block.uid, i)
    }
  }

  for (const page of pages) {
    add({
      uid: page.uid,
      kind: 'page',
      pageTitle: page.title,
      parentUid: null,
      siblingIndex: 0,
      content: page.title,
      childUids: (page.children ?? []).map(child => child.uid),
    })
    for (let i = 0; i < (page.children ?? []).length; i++) {
      visitBlock(page.children![i], page.title, page.uid, i)
    }
  }

  const duplicates = [...occurrences.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([uid, list]) => {
      const first = list[0]
      const contentConflict = list.some(occ => occurrenceContent(occ) !== occurrenceContent(first))
      const parentConflict = list.some(occ => occurrenceParent(occ) !== occurrenceParent(first))
      const childrenConflict = list.some(occ => occurrenceChildren(occ) !== occurrenceChildren(first))
      return {uid, list, first, contentConflict, parentConflict, childrenConflict}
    })

  if (duplicates.length === 0) return []

  const pageDuplicates = duplicates.filter(d => d.first.kind === 'page')
  const blockDuplicates = duplicates.filter(d => d.first.kind === 'block')
  const duplicateInstances = duplicates.reduce((sum, d) => sum + d.list.length, 0)
  const contentConflicts = duplicates.filter(d => d.contentConflict).length
  const parentConflicts = duplicates.filter(d => d.parentConflict).length
  const childrenConflicts = duplicates.filter(d => d.childrenConflict).length
  const diagnostics = [
    `Duplicate Roam uid weirdness: ${duplicates.length} uid(s) appeared across ` +
    `${duplicateInstances} export node instances (${blockDuplicates.length} block uid(s), ` +
    `${pageDuplicates.length} page uid(s)); importer emits the first block occurrence per uid ` +
    `and skips later duplicate block rows. Conflicts: ${contentConflicts} content, ` +
    `${parentConflicts} parent/page, ${childrenConflicts} child-list.`,
  ]

  const conflictSamples = duplicates
    .filter(d => d.contentConflict || d.parentConflict || d.childrenConflict || d.list.length > 2)
    .slice(0, 8)
  for (const d of conflictSamples) {
    const first = d.first
    const later = d.list.find(occ =>
      occurrenceContent(occ) !== occurrenceContent(first) ||
      occurrenceParent(occ) !== occurrenceParent(first) ||
      occurrenceChildren(occ) !== occurrenceChildren(first)
    ) ?? d.list[1]
    const conflictKinds = [
      d.contentConflict ? 'content' : '',
      d.parentConflict ? 'parent/page' : '',
      d.childrenConflict ? 'child-list' : '',
    ].filter(Boolean).join(', ') || 'repeated identical node'
    diagnostics.push(
      `Duplicate Roam uid ${d.uid} (${d.list.length} occurrences, ${conflictKinds}); ` +
      `kept first on [[${pageTitleForDiagnostic(first.pageTitle)}]] ` +
      `at sibling ${first.siblingIndex} with content ${quotedSample(first.content)}; ` +
      `sample later on [[${pageTitleForDiagnostic(later.pageTitle)}]] ` +
      `at sibling ${later.siblingIndex} with content ${quotedSample(later.content)}.`,
    )
  }

  return diagnostics
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

const collectPageTitleDiagnostics = (pages: RoamExport): string[] => {
  let blank = 0
  let whitespace = 0
  let newline = 0
  let long = 0
  for (const page of pages) {
    if (page.title === '') blank += 1
    if (page.title !== page.title.trim()) whitespace += 1
    if (page.title.includes('\n')) newline += 1
    if (page.title.length > 160) long += 1
  }
  const parts = [
    blank > 0 ? `${blank} blank` : '',
    whitespace > 0 ? `${whitespace} with leading/trailing whitespace` : '',
    newline > 0 ? `${newline} with newlines` : '',
    long > 0 ? `${long} longer than 160 chars` : '',
  ].filter(Boolean)
  return parts.length > 0
    ? [`Roam page title weirdness: ${parts.join(', ')}; imported titles literally.`]
    : []
}

const ROAM_COMMAND_RE = /\{\{\s*(?:\[\[([^\]]+)\]\]|([^\s:{}]+))/g
const ROAM_COMMANDS_HANDLED = new Set(['TODO', 'DONE', 'embed', 'embed-path'])
const ROAM_COMMANDS_KNOWN_FOLLOW_UP = new Set([
  'query',
  'audio',
  'video',
  'youtube',
  'iframe',
  'pdf',
  'tweet',
  'table',
  'calc',
])

const commandScanContent = (content: string): string => {
  let out = ''
  let i = 0
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3)
      const rangeEnd = end < 0 ? content.length : end + 3
      out += ' '.repeat(rangeEnd - i)
      i = rangeEnd
      continue
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1)
      if (end < 0) break
      out += ' '.repeat(end + 1 - i)
      i = end + 1
      continue
    }
    out += content[i]
    i += 1
  }
  return out
}

const collectRoamCommands = (content: string): string[] => {
  const out: string[] = []
  ROAM_COMMAND_RE.lastIndex = 0
  let match: RegExpExecArray | null
  const scannable = commandScanContent(content)
  while ((match = ROAM_COMMAND_RE.exec(scannable)) !== null) {
    const name = (match[1] ?? match[2] ?? '').trim()
    if (name) out.push(name)
  }
  return out
}

const formatCommandCounts = (counts: ReadonlyMap<string, number>): string =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ')

const collectRoamCommandFollowUpDiagnostics = (pages: RoamExport): string[] => {
  const knownCounts = new Map<string, number>()
  const unknownCounts = new Map<string, number>()
  const visit = (block: RoamBlock) => {
    for (const name of collectRoamCommands(block.string ?? '')) {
      if (ROAM_COMMANDS_HANDLED.has(name)) continue
      if (ROAM_COMMANDS_KNOWN_FOLLOW_UP.has(name)) {
        knownCounts.set(name, (knownCounts.get(name) ?? 0) + 1)
      } else {
        unknownCounts.set(name, (unknownCounts.get(name) ?? 0) + 1)
      }
    }
    for (const child of block.children ?? []) visit(child)
  }

  for (const page of pages) {
    for (const child of page.children ?? []) visit(child)
  }

  const diagnostics: string[] = []
  const knownTotal = [...knownCounts.values()].reduce((sum, count) => sum + count, 0)
  if (knownTotal > 0) {
    diagnostics.push(
      `Roam command follow-up: preserved ${knownTotal} known command occurrence(s) literally ` +
      `(${formatCommandCounts(knownCounts)}); media/query normalization is still a follow-up.`,
    )
  }

  const unknownTotal = [...unknownCounts.values()].reduce((sum, count) => sum + count, 0)
  if (unknownTotal > 0) {
    diagnostics.push(
      `Unknown Roam command follow-up: preserved ${unknownTotal} command occurrence(s) literally ` +
      `(${formatCommandCounts(unknownCounts)}); review custom command handling.`,
    )
  }

  return diagnostics
}

const appendReadwisePromotedMetadataDiagnostics = (
  diagnostics: string[],
  ctx: BuildContext,
) => {
  const total = [...ctx.readwisePromotedMetadataConflictCounts.values()]
    .reduce((sum, count) => sum + count, 0)
  if (total === 0) return
  const formattedCounts = [...ctx.readwisePromotedMetadataConflictCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([note, count]) => `${note} ${count}`)
    .join(', ')
  diagnostics.push(
    `Readwise promoted metadata conflicts: handled ${total} promoted child metadata conflict(s) ` +
    `without letting Matrix/source metadata overwrite article metadata (${formattedCounts}).`,
  )
  for (const sample of ctx.readwisePromotedMetadataConflictSamples) {
    diagnostics.push(`Readwise promoted metadata conflict sample: ${sample}.`)
  }
}

const pageTitleForDiagnostic = (title: string): string => {
  const normalized = title.replace(/\s+/g, ' ').trim()
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}

const appendPageAliasDiagnostics = (
  diagnostics: string[],
  page: RoamPage,
  properties: Record<string, unknown>,
) => {
  const values = nonStandardPageAliasValues(properties)
  if (values.length === 0) return
  const sample = values
    .slice(0, 3)
    .map(value => JSON.stringify(value))
    .join(', ')
  diagnostics.push(
    `Non-standard page_alias on [[${pageTitleForDiagnostic(page.title)}]] ` +
    `(uid ${page.uid}) was not used for alias-rule merging: ${sample}`,
  )
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
  diagnostics.push(...collectDuplicateUidDiagnostics(pages))
  diagnostics.push(...collectPageTitleDiagnostics(pages))
  diagnostics.push(...collectRoamCommandFollowUpDiagnostics(pages))
  const ctx: BuildContext = {
    options,
    uidMap,
    roamMemoByTargetUid: roamMemo.byTargetUid,
    aliasesUsed: new Set(),
    unresolvedBlockUids: new Set(),
    diagnostics,
    emittedBlockUids: new Set(),
    readwisePromotedMetadataConflictCounts: new Map(),
    readwisePromotedMetadataConflictSamples: [],
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
    const pageProperties = {
      ...promotedFromChildren,
      ...propertiesFromRoam(pageRoamProps),
    }
    const pageAliases = collectPageAliases(pageProperties)
    appendPageAliasDiagnostics(diagnostics, page, pageProperties)

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
      roamUid: page.uid,
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

  appendReadwisePromotedMetadataDiagnostics(diagnostics, ctx)

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
