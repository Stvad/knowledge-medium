// Roam-import orchestrator. Drives a live Repo: pre-resolves aliases,
// reconciles existing pages (daily-note dedup + alias-merge), then
// writes the planned tree.
//
// Design intent
//   - The pure planner (`planImport`) has already laid out IDs, content
//     rewrites, parent/child links via parentId+orderKey, and partial
//     references[] data.
//   - This module bridges plan → live system, handling the parts that
//     need to talk to the workspace: looking up existing alias-pages so
//     we can merge instead of duplicate, materialising daily-notes via
//     the deterministic-id path, and converting [[alias]] occurrences
//     into resolved references[] rows so backlinks work after import.

import {
  ChangeScope,
  DeletedConflictError,
  type BlockData,
  type NewBlockData,
  type Tx,
} from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/data/dailyNotes'
import { parseRelativeDate } from '@/utils/relativeDate'
import { parseReferences } from '@/utils/referenceParser'
import type { Repo } from '@/data/internals/repo'
import { v4 as uuidv4 } from 'uuid'
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
  /**
   * Empty stand-in blocks created for `((uid))` references whose target
   * wasn't in this export. A future import that brings in the real
   * blocks will upsert onto the same ids and replace the placeholder.
   */
  placeholdersCreated: number
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
      placeholdersCreated: plan.placeholders.length,
      diagnostics: plan.diagnostics,
      durationMs: Date.now() - start,
      dryRun: true,
    }
  }

  // 4. Make sure the daily-note rows referenced by daily-page
  //    reconciliations exist. getOrCreateDailyNote opens its own tx
  //    and is idempotent — safe to call concurrently across imports.
  for (const recon of reconciliations) {
    if (recon.page.isDaily) {
      await mergeIntoDailyNote(repo, options.workspaceId, recon.page)
    }
  }

  // 5. Write placeholders + descendants + non-daily pages in one
  //    big tx. Re-parenting (planned → final) is applied to each
  //    descendant's `parentId` before tx.createOrGet so the row
  //    lands under the right parent without a follow-up move.
  let pagesCreated = 0
  let pagesMerged = 0
  const pagesDaily = reconciliations.filter(r => r.page.isDaily).length
  await repo.tx(async tx => {
    // 5a. Placeholder stand-ins. Idempotent — re-running is a no-op
    //     against a live row, and a future import that contains the
    //     real block upserts onto the same row via upsertImportedBlock
    //     (5c). On a tombstone we restore with the empty stub so
    //     references[] in other blocks can still resolve.
    for (const placeholder of plan.placeholders) {
      await ensurePlaceholderRow(tx, {
        id: placeholder.blockId,
        workspaceId: options.workspaceId,
      })
    }

    // 5b. Non-daily pages. Pages must land BEFORE descendants — the
    //     workspace-invariant trigger requires parent rows to exist
    //     at insert time, and descendants are emitted leaves-first
    //     (post-order) so their parents (intermediate blocks + the
    //     page row) need to be in place. Daily pages were already
    //     created in step 4. Merging pages get an alias union via
    //     mergeIntoExistingPage; non-merging pages create the row.
    for (const recon of reconciliations) {
      if (recon.page.isDaily) continue
      if (recon.merging) {
        pagesMerged += 1
        await mergeIntoExistingPage(tx, recon)
        continue
      }
      pagesCreated += 1
      if (!recon.page.data) throw new Error('Non-daily, non-merging page must have data')
      await upsertImportedBlock(tx, recon.page.data)
    }

    // 5c. Descendants. The planner emits them in post-order (leaves
    //     before parents); we iterate in reverse so each descendant's
    //     parent is already in the table when its insert fires the
    //     workspace-invariant trigger. Page ancestors were written
    //     in 5b; intermediate descendants come from this loop.
    for (let i = plan.descendants.length - 1; i >= 0; i--) {
      const desc = plan.descendants[i]
      const data = applyReparent(desc.data, reparentMap)
      await upsertImportedBlock(tx, data)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'roam import'})

  log(`Wrote ${plan.placeholders.length} placeholders, ${plan.descendants.length} descendants, ` +
    `${pagesCreated} new pages, ${pagesMerged} merged, ${pagesDaily} daily-notes`)

  return {
    pagesCreated,
    pagesMerged,
    pagesDaily,
    blocksWritten: plan.descendants.length,
    aliasesResolved: aliasResolution.aliasIdMap.size,
    aliasBlocksCreated: aliasResolution.aliasBlocksCreated,
    placeholdersCreated: plan.placeholders.length,
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

    // Create a new alias-target block in its own short tx so the row
    // is committable independently of the main import tx (parseRefs
    // post-commit processor needs a live workspace and we want it
    // running here).
    const newId = uuidv4()
    await repo.tx(async tx => {
      await tx.create({
        id: newId,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: alias,
        properties: {[aliasesProp.name]: aliasesProp.codec.encode([alias])},
      })
    }, {scope: ChangeScope.BlockDefault, description: `roam import: alias target ${alias}`})
    aliasIdMap.set(alias, newId)
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
  // Materialize the daily note row (idempotent). The descendants are
  // created later in the main import tx with parentId already pointing
  // at this row (the planner used dailyNoteBlockId as the plannedId,
  // so reparentMap leaves them alone).
  await getOrCreateDailyNote(repo, workspaceId, page.iso)
}

/**
 * Ensure a placeholder row exists at `id`. Used for ((uid)) targets
 * whose real block isn't in this export — references[] in imported
 * content needs the row to be present so backlinks resolve. Three
 * branches:
 *   - Fresh insert: write an empty stub at workspace root.
 *   - Live-row hit: leave alone (a real block with content may
 *     already live at this id; a placeholder must NOT clobber it).
 *   - Tombstone hit: tx.restore with empty content so the row comes
 *     back to life and references resolve. The user can re-delete
 *     after the import if they were intentionally cleaning up;
 *     leaving the row tombstoned would crash the import tx.
 */
const ensurePlaceholderRow = async (
  tx: Tx,
  {id, workspaceId}: {id: string; workspaceId: string},
) => {
  try {
    await tx.createOrGet({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: '',
    })
  } catch (err) {
    if (!(err instanceof DeletedConflictError)) throw err
    await tx.restore(id, {content: ''})
  }
}

/**
 * Insert a planned block, OR upgrade an existing row at the same id.
 *
 * Three branches:
 *   - Fresh insert (createOrGet returns inserted=true): nothing else
 *     to do — the row was written with the planned data.
 *   - Live-row hit (inserted=false): apply the planned content /
 *     properties / references via tx.update and re-parent via
 *     tx.move so a prior placeholder gets upgraded.
 *   - Tombstone hit (createOrGet throws DeletedConflictError):
 *     tx.restore writes deleted=0 + the data-field patch in one
 *     UPDATE; tx.move handles parent_id + order_key. Without this
 *     branch a re-import of a previously-deleted Roam block / page
 *     would crash the entire import tx.
 *
 * Last-write-wins is the explicit semantics on the live-row path:
 * re-imports overwrite local edits at the same id. Same on the
 * tombstone path — re-importing resurrects the row with the planned
 * data rather than the user's pre-deletion state.
 */
const upsertImportedBlock = async (
  tx: Tx,
  data: NewBlockData & {id: string; content: string},
) => {
  try {
    const result = await tx.createOrGet({
      id: data.id,
      workspaceId: data.workspaceId,
      parentId: data.parentId,
      orderKey: data.orderKey,
      content: data.content,
      properties: data.properties,
      references: data.references,
    })
    if (result.inserted) return
    await tx.update(data.id, {
      content: data.content,
      properties: data.properties ?? {},
      references: data.references ?? [],
    })
    await tx.move(data.id, {parentId: data.parentId, orderKey: data.orderKey})
  } catch (err) {
    if (!(err instanceof DeletedConflictError)) throw err
    await tx.restore(data.id, {
      content: data.content,
      properties: data.properties ?? {},
      references: data.references ?? [],
    })
    await tx.move(data.id, {parentId: data.parentId, orderKey: data.orderKey})
  }
}

const mergeIntoExistingPage = async (tx: Tx, recon: PageReconciliation) => {
  const existing = await tx.get(recon.finalId)
  if (!existing) {
    throw new Error(`mergeIntoExistingPage: existing page ${recon.finalId} not found`)
  }
  // Make sure the existing page records the imported alias too — Roam
  // can have aliases the local block doesn't know about. If the title
  // already appears, this is a no-op.
  const aliasesValue = existing.properties[aliasesProp.name]
  const aliases = Array.isArray(aliasesValue)
    ? aliasesValue.filter((v): v is string => typeof v === 'string')
    : []
  if (!aliases.includes(recon.page.title)) {
    await tx.setProperty(recon.finalId, aliasesProp, [...aliases, recon.page.title])
  }
  if (existing.properties[typeProp.name] === undefined) {
    await tx.setProperty(recon.finalId, typeProp, 'page')
  }
  // Descendants are already routed under recon.finalId via the
  // reparentMap (their parentId was rewritten before tx.createOrGet).
  // No explicit child-list manipulation needed in the new shape.
}
