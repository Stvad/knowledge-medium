// Roam-import orchestrator. Drives a live Repo: pre-resolves aliases,
// reconciles existing pages (daily-note dedup + alias-merge), then
// writes the planned tree.
//
// Design intent
//   - The pure planner (`planImport`) has already laid out IDs, content
//     rewrites, parent/child links, and partial references[] data.
//   - This module bridges plan → live system, handling the parts that
//     need to talk to the workspace: looking up existing alias-pages so
//     we can merge instead of duplicate, materialising daily-notes via
//     the deterministic-id path, and converting [[alias]] occurrences
//     into resolved references[] rows so backlinks work after import.

import { aliasProp, fromList, typeProp } from '@/data/properties'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/data/dailyNotes'
import { parseRelativeDate } from '@/utils/relativeDate'
import { parseReferences } from '@/utils/referenceParser'
import { Repo } from '@/data/repo'
import { BlockData } from '@/types'
import { planImport, type PreparedPage, type RoamImportPlan } from './plan'
import type { RoamExport } from './types'

type AliasIdMap = ReadonlyMap<string, string>

interface PageReconciliation {
  /** Plan-side blockId; matches data.parentId for direct children. */
  plannedId: string
  /** Final blockId after merge resolution. May equal plannedId. */
  finalId: string
  page: PreparedPage
  /** True when an existing block already owns this title's alias. */
  merging: boolean
}

export interface RoamImportOptions {
  workspaceId: string
  currentUserId: string
  /** Don't write anything; return what would be written. */
  dryRun?: boolean
  /** Surface progress / decisions for long imports. */
  onProgress?: (msg: string) => void
}

export interface RoamImportSummary {
  pagesCreated: number
  pagesMerged: number
  pagesDaily: number
  blocksWritten: number
  aliasesResolved: number
  aliasBlocksCreated: number
  unresolvedBlockUids: string[]
  diagnostics: string[]
  durationMs: number
  dryRun: boolean
}

export const importRoam = async (
  pages: RoamExport,
  repo: Repo,
  options: RoamImportOptions,
): Promise<RoamImportSummary> => {
  const start = Date.now()
  const log = (msg: string) => options.onProgress?.(msg)

  const plan = planImport(pages, {
    workspaceId: options.workspaceId,
    currentUserId: options.currentUserId,
  })

  log(`Planned ${plan.pages.length} pages, ${plan.descendants.length} descendant blocks`)

  // 1. Reconcile pages against the live workspace so we know which
  //    plannedIds get rerouted to existing alias-pages.
  const reconciliations = await reconcilePages(plan.pages, repo, options.workspaceId)
  const reparentMap = buildReparentMap(reconciliations)

  // 2. Build alias → blockId map for every alias mentioned in content.
  //    Done before we patch references so the patch sees the final ids.
  const aliasResolution = await resolveAliases(
    plan.aliasesUsed,
    reconciliations,
    repo,
    options.workspaceId,
    options.dryRun ?? false,
  )

  // 3. Patch references[] on every block with the alias rows.
  for (const desc of plan.descendants) {
    patchAliasReferences(desc.data, aliasResolution.aliasIdMap)
  }
  for (const page of plan.pages) {
    if (page.data) patchAliasReferences(page.data, aliasResolution.aliasIdMap)
  }

  if (options.dryRun) {
    return {
      pagesCreated: reconciliations.filter(r => !r.merging && !r.page.isDaily).length,
      pagesMerged: reconciliations.filter(r => r.merging).length,
      pagesDaily: reconciliations.filter(r => r.page.isDaily).length,
      blocksWritten: plan.descendants.length,
      aliasesResolved: aliasResolution.aliasIdMap.size,
      aliasBlocksCreated: aliasResolution.aliasBlocksCreated,
      unresolvedBlockUids: [...plan.unresolvedBlockUids],
      diagnostics: plan.diagnostics,
      durationMs: Date.now() - start,
      dryRun: true,
    }
  }

  // 4. Write descendants. Reparent direct children of merging pages.
  for (const desc of plan.descendants) {
    const data = applyReparent(desc.data, reparentMap)
    repo.create(data)
  }
  log(`Wrote ${plan.descendants.length} descendant blocks`)

  // 5. Write or merge each page.
  let pagesCreated = 0
  let pagesMerged = 0
  let pagesDaily = 0
  for (const recon of reconciliations) {
    if (recon.page.isDaily) {
      pagesDaily += 1
      await mergeIntoDailyNote(repo, options.workspaceId, recon.page)
      continue
    }
    if (recon.merging) {
      pagesMerged += 1
      mergeIntoExistingPage(repo, recon)
      continue
    }
    pagesCreated += 1
    if (!recon.page.data) throw new Error('Non-daily, non-merging page must have data')
    repo.create(recon.page.data)
  }
  log(
    `Pages: ${pagesCreated} created, ${pagesMerged} merged into existing aliases, ${pagesDaily} daily-note merges`,
  )

  await repo.flush()

  return {
    pagesCreated,
    pagesMerged,
    pagesDaily,
    blocksWritten: plan.descendants.length,
    aliasesResolved: aliasResolution.aliasIdMap.size,
    aliasBlocksCreated: aliasResolution.aliasBlocksCreated,
    unresolvedBlockUids: [...plan.unresolvedBlockUids],
    diagnostics: plan.diagnostics,
    durationMs: Date.now() - start,
    dryRun: false,
  }
}

const reconcilePages = async (
  preparedPages: RoamImportPlan['pages'],
  repo: Repo,
  workspaceId: string,
): Promise<PageReconciliation[]> => {
  const out: PageReconciliation[] = []
  for (const page of preparedPages) {
    if (page.isDaily) {
      // Daily pages always route through getOrCreateDailyNote. Plan id
      // already equals dailyNoteBlockId, so finalId === plannedId and
      // there's no reparenting.
      out.push({plannedId: page.blockId, finalId: page.blockId, page, merging: false})
      continue
    }

    const existing = await repo.findBlockByAliasInWorkspace(workspaceId, page.title)
    if (existing) {
      out.push({plannedId: page.blockId, finalId: existing.id, page, merging: true})
      continue
    }
    out.push({plannedId: page.blockId, finalId: page.blockId, page, merging: false})
  }
  return out
}

const buildReparentMap = (recons: PageReconciliation[]): Map<string, string> => {
  const map = new Map<string, string>()
  for (const r of recons) {
    if (r.plannedId !== r.finalId) map.set(r.plannedId, r.finalId)
  }
  return map
}

const applyReparent = (data: BlockData, reparent: Map<string, string>): BlockData => {
  if (!data.parentId) return data
  const reparented = reparent.get(data.parentId)
  if (!reparented) return data
  return {...data, parentId: reparented}
}

interface AliasResolution {
  aliasIdMap: Map<string, string>
  aliasBlocksCreated: number
}

const resolveAliases = async (
  aliases: ReadonlySet<string>,
  recons: PageReconciliation[],
  repo: Repo,
  workspaceId: string,
  dryRun: boolean,
): Promise<AliasResolution> => {
  const aliasIdMap = new Map<string, string>()
  let aliasBlocksCreated = 0

  // First, alias = imported-page-title shortcuts to that page's final id
  // (covers references between imported pages, including merge-into
  // existing alias).
  const importedPagesByTitle = new Map<string, string>()
  for (const r of recons) importedPagesByTitle.set(r.page.title, r.finalId)

  for (const alias of aliases) {
    const importedHit = importedPagesByTitle.get(alias)
    if (importedHit) {
      aliasIdMap.set(alias, importedHit)
      continue
    }

    const parsedDate = parseRelativeDate(alias)
    if (parsedDate) {
      // Daily-shaped alias resolves to its deterministic id. In dryRun
      // we report the would-be id without materialising the row.
      if (dryRun) {
        aliasIdMap.set(alias, dailyNoteBlockId(workspaceId, parsedDate.iso))
        continue
      }
      const dailyBlock = await getOrCreateDailyNote(repo, workspaceId, parsedDate.iso)
      aliasIdMap.set(alias, dailyBlock.id)
      continue
    }

    const existing = await repo.findBlockByAliasInWorkspace(workspaceId, alias)
    if (existing) {
      aliasIdMap.set(alias, existing.id)
      continue
    }

    if (dryRun) {
      // Reserve a placeholder id so references[] stay computed; the actual
      // alias-block won't be created.
      continue
    }

    const aliasBlock = repo.create({
      workspaceId,
      content: alias,
      properties: fromList(aliasProp([alias])),
    })
    aliasIdMap.set(alias, aliasBlock.id)
    aliasBlocksCreated += 1
  }

  return {aliasIdMap, aliasBlocksCreated}
}

const patchAliasReferences = (data: BlockData, aliasIdMap: AliasIdMap) => {
  const parsed = parseReferences(data.content)
  if (parsed.length === 0) return

  const seen = new Set(data.references.map(r => `${r.id}:${r.alias}`))

  for (const ref of parsed) {
    const id = aliasIdMap.get(ref.alias)
    if (!id) continue
    const key = `${id}:${ref.alias}`
    if (seen.has(key)) continue
    seen.add(key)
    data.references.push({id, alias: ref.alias})
  }
}

const mergeIntoDailyNote = async (
  repo: Repo,
  workspaceId: string,
  page: PreparedPage,
) => {
  if (!page.iso) throw new Error('Daily page is missing iso date')
  const daily = await getOrCreateDailyNote(repo, workspaceId, page.iso)

  daily.change((doc) => {
    for (const childId of page.childIds) {
      if (!doc.childIds.includes(childId)) doc.childIds.push(childId)
    }
  })
}

const mergeIntoExistingPage = (repo: Repo, recon: PageReconciliation) => {
  const existing = repo.find(recon.finalId)

  // Make sure the existing page records the imported alias too — Roam
  // can have aliases the local block doesn't know about (e.g. ISO
  // alternate). If the title matches an existing alias, this is a no-op.
  existing.change((doc) => {
    const aliasValue = doc.properties.alias?.value
    const aliases = Array.isArray(aliasValue) ? aliasValue.filter(v => typeof v === 'string') as string[] : []
    if (!aliases.includes(recon.page.title)) {
      const updated = [...aliases, recon.page.title]
      doc.properties.alias = aliasProp(updated)
    }
    if (!doc.properties.type) {
      doc.properties.type = {...typeProp, value: 'page'}
    }
    for (const childId of recon.page.childIds) {
      if (!doc.childIds.includes(childId)) doc.childIds.push(childId)
    }
  })
}
