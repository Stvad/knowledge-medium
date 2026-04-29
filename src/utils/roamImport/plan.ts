import { BlockData, BlockProperties, NumberBlockProperty, StringBlockProperty } from '@/types'

// Inline alias of BlockData['references'][number] — `BlockReference` is
// exported from a sibling branch (pedantic-murdock-11fc9b) but not yet on
// master, so we mirror the shape here to stay buildable until that lands.
type BlockReference = {id: string, alias: string}
import { aliasProp, fromList, numberProperty, stringProperty, typeProp } from '@/data/properties'
import { parseReferences } from '@/utils/referenceParser'
import { applyHeading, rewriteRoamContent } from './content'
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
  /** First-level child block ids (in order). */
  childIds: string[]
}

export interface PreparedBlock {
  data: BlockData
  roamUid: string
}

export interface RoamImportPlan {
  pages: PreparedPage[]
  /** Non-page blocks, in post-order — leaves before parents within each page. */
  descendants: PreparedBlock[]
  /** Roam-uid → our-uuid map (covers pages and blocks). */
  uidMap: Map<string, string>
  /** Aliases referenced from content (plain `[[alias]]`). Page-by-name lookup target. */
  aliasesUsed: Set<string>
  /** Block uids used in content but absent from this export. */
  unresolvedBlockUids: Set<string>
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

const collectRoamProps = (block: RoamBlock | RoamPage): Record<string, unknown> => {
  const fromBlockProps = (block[':block/props'] ?? block.props ?? {}) as Record<string, unknown>
  return {...fromBlockProps, ...getExtraRoamProps(block)}
}

const propertiesFromRoam = (
  raw: Record<string, unknown>,
): Record<string, NumberBlockProperty | StringBlockProperty> => {
  const out: Record<string, NumberBlockProperty | StringBlockProperty> = {}

  for (const [key, value] of Object.entries(raw)) {
    const propName = namespacedKey(key)
    if (typeof value === 'number') {
      out[propName] = numberProperty(propName, value)
    } else if (typeof value === 'string') {
      out[propName] = stringProperty(propName, value)
    } else if (value !== null && value !== undefined) {
      // Object/array values aren't well-typed in our property system yet.
      // Stringify so the data round-trips; a follow-up can promote
      // structured values once we have more known shapes.
      out[propName] = stringProperty(propName, JSON.stringify(value))
    }
  }

  return out
}

interface BuildContext {
  options: PlanOptions
  uidMap: Map<string, string>
  aliasesUsed: Set<string>
  unresolvedBlockUids: Set<string>
}

const buildBlock = (
  ctx: BuildContext,
  block: RoamBlock,
  parentId: string,
  pushDescendant: (b: PreparedBlock) => void,
): string => {
  const id = ctx.uidMap.get(block.uid)
  if (!id) throw new Error(`Roam uid not in uidMap: ${block.uid}`)

  const childIds: string[] = []
  for (const child of block.children ?? []) {
    childIds.push(buildBlock(ctx, child, id, pushDescendant))
  }

  const data = composeBlockData({
    ctx,
    id,
    parentId,
    childIds,
    rawString: block.string,
    heading: block.heading,
    roamProps: collectRoamProps(block),
    roamRefUids: collectUidRefs(block),
    createTime: cloneTimestamp(block['create-time'], Date.now()),
    updateTime: cloneTimestamp(block['edit-time'] ?? block['create-time'], Date.now()),
  })

  pushDescendant({data, roamUid: block.uid})
  return id
}

interface ComposeArgs {
  ctx: BuildContext
  id: string
  parentId: string | undefined
  childIds: string[]
  rawString: string
  heading?: number
  roamProps: Record<string, unknown>
  roamRefUids: string[]
  createTime: number
  updateTime: number
  extraProperties?: BlockProperties
}

const composeBlockData = (args: ComposeArgs): BlockData => {
  const {ctx, id, parentId, childIds, rawString, heading, roamProps, roamRefUids, createTime, updateTime, extraProperties} = args

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

  const properties: BlockProperties = {
    ...propertiesFromRoam(roamProps),
    ...(extraProperties ?? {}),
  }

  const data: BlockData = {
    id,
    workspaceId: ctx.options.workspaceId,
    content,
    properties,
    childIds,
    parentId,
    createTime,
    updateTime,
    createdByUserId: ctx.options.currentUserId,
    updatedByUserId: ctx.options.currentUserId,
    references: blockRefs,
    deleted: false,
  }

  return data
}

const buildUidMap = (
  pages: RoamExport,
  workspaceId: string,
): {uidMap: Map<string, string>, dailyByUid: Map<string, {iso: string, blockId: string}>} => {
  const uidMap = new Map<string, string>()
  const dailyByUid = new Map<string, {iso: string, blockId: string}>()

  const visit = (block: RoamBlock) => {
    if (!uidMap.has(block.uid)) {
      uidMap.set(block.uid, roamBlockId(workspaceId, block.uid))
    }
    for (const child of block.children ?? []) visit(child)
  }

  for (const page of pages) {
    const daily = resolveDailyPage(workspaceId, page)
    if (daily) {
      dailyByUid.set(page.uid, daily)
      uidMap.set(page.uid, daily.blockId)
    } else {
      uidMap.set(page.uid, roamBlockId(workspaceId, page.uid))
    }
    for (const child of page.children ?? []) visit(child)
  }

  return {uidMap, dailyByUid}
}

export const planImport = (pages: RoamExport, options: PlanOptions): RoamImportPlan => {
  const {uidMap, dailyByUid} = buildUidMap(pages, options.workspaceId)

  const ctx: BuildContext = {
    options,
    uidMap,
    aliasesUsed: new Set(),
    unresolvedBlockUids: new Set(),
  }

  const preparedPages: PreparedPage[] = []
  const descendants: PreparedBlock[] = []
  const diagnostics: string[] = []

  const pushDescendant = (b: PreparedBlock) => descendants.push(b)

  for (const page of pages) {
    const daily = dailyByUid.get(page.uid)
    const pageBlockId = uidMap.get(page.uid)
    if (!pageBlockId) throw new Error(`Page uid not in uidMap: ${page.uid}`)

    const childIds: string[] = []
    for (const child of page.children ?? []) {
      childIds.push(buildBlock(ctx, child, pageBlockId, pushDescendant))
    }

    if (daily) {
      preparedPages.push({
        blockId: pageBlockId,
        roamUid: page.uid,
        title: page.title,
        isDaily: true,
        iso: daily.iso,
        childIds,
      })
      continue
    }

    // Non-daily top-level page: build the page block. The orchestrator
    // will check for an existing block with this alias before deciding
    // to create vs merge.
    const titleAliasProp = aliasProp([page.title])
    const pageData = composeBlockData({
      ctx,
      id: pageBlockId,
      parentId: undefined,
      childIds,
      rawString: page.title,
      heading: undefined,
      roamProps: collectRoamProps(page),
      roamRefUids: collectUidRefs(page),
      createTime: cloneTimestamp(page['create-time'], Date.now()),
      updateTime: cloneTimestamp(page['edit-time'] ?? page['create-time'], Date.now()),
      extraProperties: fromList(titleAliasProp, {...typeProp, value: 'page'}),
    })

    preparedPages.push({
      blockId: pageBlockId,
      roamUid: page.uid,
      title: page.title,
      isDaily: false,
      data: pageData,
      childIds,
    })
  }

  if (ctx.unresolvedBlockUids.size > 0) {
    diagnostics.push(
      `${ctx.unresolvedBlockUids.size} block-ref uid(s) not present in this export — left literal in content.`,
    )
  }

  return {
    pages: preparedPages,
    descendants,
    uidMap,
    aliasesUsed: ctx.aliasesUsed,
    unresolvedBlockUids: ctx.unresolvedBlockUids,
    diagnostics,
  }
}
