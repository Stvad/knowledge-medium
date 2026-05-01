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
import { computeAliasSeatId } from '@/data/internals/targets'
import { parseRelativeDate } from '@/utils/relativeDate'
import { parseReferences } from '@/utils/referenceParser'
import type { Repo } from '@/data/internals/repo'
import { planImport, type PreparedPage, type RoamImportPlan } from './plan'
import type { RoamExport } from './types'

type AliasIdMap = ReadonlyMap<string, string>

/** How many descendant rows to write per tx. Trade-off:
 *  - Smaller chunks → smaller TxEngine snapshot Map per commit and
 *    faster handle-invalidation pass after each commit, but more
 *    per-tx overhead (BEGIN/COMMIT, command_events row, undo entry,
 *    one PowerSync upload tx per chunk).
 *  - Larger chunks → fewer commit-time costs amortised over more
 *    rows, but the snapshot Map and the post-commit O(snapshots)
 *    work blow up on huge imports.
 *
 *  5K is a balance for the 150-MB-class graphs the optimisation
 *  targets — empirically the snapshot pass starts to feel sluggish
 *  past ~10K-20K, and per-tx fixed cost dominates below ~1K. Tune
 *  later if profiling moves the needle. Not exposed as an option
 *  for now; callers don't need a knob, they need it fast. */
const DESCENDANT_CHUNK_SIZE = 5000

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
  /** Override the default descendant-tx chunk size. Provided so tests
   *  can exercise multi-chunk behaviour without generating thousands
   *  of rows; production callers should leave this unset. */
  descendantChunkSize?: number
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
  //    Pure planning — no DB writes here. Seat-materialisation for
  //    unowned aliases happens inside the main tx in step 5b.
  const aliasResolution = await resolveAliases(
    plan.aliasesUsed,
    reconciliations,
    repo,
    options.workspaceId,
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
      // dryRun keeps historical 0 — we'd attempt seat creation for
      // every aliasesNeedingSeat entry but can't tell up-front which
      // would be a fresh insert vs a live-row hit.
      aliasBlocksCreated: 0,
      placeholdersCreated: plan.placeholders.length,
      diagnostics: plan.diagnostics,
      durationMs: Date.now() - start,
      dryRun: true,
    }
  }

  // 4. Make sure the daily-note rows referenced by daily-page
  //    reconciliations OR by daily-shaped aliases used in content
  //    exist. getOrCreateDailyNote opens its own tx, sets up the
  //    journal-page parent link, and is idempotent — first call per
  //    iso writes, subsequent calls hit the repo cache. Folding into
  //    the main import tx would require duplicating the journal
  //    creation logic, and dailies are typically O(years) not
  //    O(unique_aliases), so the gain isn't worth the duplication.
  const dailyIsos = collectDailyIsos(reconciliations, aliasResolution.aliasIdMap, plan.aliasesUsed)
  for (const iso of dailyIsos) {
    await getOrCreateDailyNote(repo, options.workspaceId, iso)
  }

  // 5. Write the import in two phases — one frontmatter tx (alias
  //    seats + placeholders + pages) followed by chunked descendant
  //    txs. Two reasons we don't ship one giant tx:
  //
  //    Memory: TxEngine accumulates a snapshot per write in an
  //    in-memory Map until commit. A 150-MB Roam graph hits millions
  //    of rows; the snapshots map (plus the post-commit
  //    handle-invalidation walk that's O(snapshots)) would dominate
  //    heap and stall the UI on commit.
  //
  //    Progress: a single tx is all-or-nothing — the user has no idea
  //    how far in we are, and a crash 90 % through means restarting
  //    from zero. Chunked txs commit incrementally so re-runs land on
  //    populated rows (idempotent via createOrGet / DeletedConflict
  //    restore) and the `onProgress` callback can show meaningful
  //    counts.
  //
  //    What we lose: cross-chunk atomicity. If the descendant phase
  //    fails halfway, the workspace is left with frontmatter + a
  //    prefix of descendants. That's recoverable (re-running the
  //    import upserts the rest at the same ids); a millions-row tx
  //    that fails and rolls back is also recoverable but at much
  //    higher cost in time + memory. Net favourable.
  let pagesCreated = 0
  let pagesMerged = 0
  let aliasBlocksCreated = 0
  const pagesDaily = reconciliations.filter(r => r.page.isDaily).length
  await repo.tx(async tx => {
    // 5a. Alias-target seats for unowned aliases. Same idempotent
    //     shape as parseReferencesProcessor's ensureAliasTarget — at
    //     the deterministic id, with `aliases: [alias]` on insert /
    //     restore. A live row at the seat (e.g. created earlier by
    //     parseReferences when the user typed `[[alias]]` before
    //     importing) is left alone; tombstones restore. The legacy
    //     code wrote `content: alias` so the imported alias-block had
    //     a visible title — preserved here for UI parity (user types
    //     `[[Foo]]` → empty stub; Roam imports `[[Foo]]` → "Foo"
    //     content for findability).
    for (const alias of aliasResolution.aliasesNeedingSeat) {
      const result = await ensureAliasSeat(tx, {
        alias,
        workspaceId: options.workspaceId,
      })
      if (result.inserted) aliasBlocksCreated += 1
    }

    // 5b. Placeholder stand-ins. Idempotent — re-running is a no-op
    //     against a live row, and a future import that contains the
    //     real block upserts onto the same row via upsertImportedBlock
    //     (5d). On a tombstone we restore with the empty stub so
    //     references[] in other blocks can still resolve.
    for (const placeholder of plan.placeholders) {
      await ensurePlaceholderRow(tx, {
        id: placeholder.blockId,
        workspaceId: options.workspaceId,
      })
    }

    // 5c. Non-daily pages. Pages must land BEFORE descendants — the
    //     workspace-invariant trigger requires parent rows to exist
    //     at insert time, and descendants are emitted leaves-first
    //     (post-order) so their parents (intermediate blocks + the
    //     page row) need to be in place. Daily pages were already
    //     created in step 4. Merging pages get an alias union via
    //     mergeIntoExistingPage; non-merging pages create the row.
    for (const recon of reconciliations) {
      if (recon.page.isDaily) {
        await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren)
        continue
      }
      if (recon.merging) {
        pagesMerged += 1
        await mergeIntoExistingPage(tx, recon)
        await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren)
        continue
      }
      pagesCreated += 1
      if (!recon.page.data) throw new Error('Non-daily, non-merging page must have data')
      await upsertImportedBlock(tx, recon.page.data)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'roam import: pages'})

  log(`Wrote frontmatter: ${plan.placeholders.length} placeholders, ` +
    `${pagesCreated} new pages, ${pagesMerged} merged, ${pagesDaily} daily-notes, ` +
    `${aliasBlocksCreated} alias seats`)

  // 5d. Descendants in chunks. Planner emits them in post-order
  //     (leaves before parents); we walk in reverse so each
  //     descendant's parent is already committed (either from
  //     frontmatter tx above, or from an earlier descendant chunk).
  //     A parent + child split across two chunks is safe — the
  //     parent commits first, the child sees it via the workspace-
  //     invariant trigger's committed-state read.
  const total = plan.descendants.length
  const chunkSize = options.descendantChunkSize ?? DESCENDANT_CHUNK_SIZE
  let written = 0
  for (let chunkStart = total - 1; chunkStart >= 0; chunkStart -= chunkSize) {
    const chunkEnd = Math.max(0, chunkStart - chunkSize + 1)
    await repo.tx(async tx => {
      for (let i = chunkStart; i >= chunkEnd; i--) {
        const desc = plan.descendants[i]
        const data = applyReparent(desc.data, reparentMap)
        await upsertImportedBlock(tx, data)
      }
    }, {scope: ChangeScope.BlockDefault, description: 'roam import: descendants'})
    written += chunkStart - chunkEnd + 1
    log(`Wrote descendants ${written}/${total}`)
  }

  return {
    pagesCreated,
    pagesMerged,
    pagesDaily,
    blocksWritten: plan.descendants.length,
    aliasesResolved: aliasResolution.aliasIdMap.size,
    aliasBlocksCreated,
    placeholdersCreated: plan.placeholders.length,
    diagnostics: plan.diagnostics,
    durationMs: Date.now() - start,
    dryRun: false,
  }
}

/** Distinct ISO dates that need a daily-note row before the main tx
 *  commits — the union of (imported daily pages, daily-shaped aliases
 *  referenced in content). Deduplicated so a 1000-block import that
 *  references `[[2026-04-28]]` 500 times calls getOrCreateDailyNote
 *  once per unique date, not once per occurrence. */
const collectDailyIsos = (
  recons: PageReconciliation[],
  aliasIdMap: AliasIdMap,
  aliasesUsed: ReadonlySet<string>,
): string[] => {
  const isos = new Set<string>()
  for (const r of recons) {
    if (r.page.isDaily && r.page.iso) isos.add(r.page.iso)
  }
  for (const alias of aliasesUsed) {
    const parsed = parseRelativeDate(alias)
    if (parsed && aliasIdMap.has(alias)) isos.add(parsed.iso)
  }
  return [...isos]
}

/** Idempotent seat materialisation for unowned aliases — at the
 *  deterministic `computeAliasSeatId(alias, ws)` location. Mirrors
 *  ensureAliasTarget's shape but writes `content: alias` (visible
 *  title for UI) instead of empty content. A live row at the seat is
 *  left alone; tombstones restore as a fresh stub. */
const ensureAliasSeat = async (
  tx: Tx,
  {alias, workspaceId}: {alias: string; workspaceId: string},
): Promise<{ id: string; inserted: boolean }> => {
  const id = computeAliasSeatId(alias, workspaceId)
  const properties = {[aliasesProp.name]: aliasesProp.codec.encode([alias])}
  try {
    const result = await tx.createOrGet({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: alias,
      properties,
    })
    return result
  } catch (err) {
    if (!(err instanceof DeletedConflictError)) throw err
    await tx.restore(id, {content: alias, properties, references: []})
    await tx.move(id, {parentId: null, orderKey: 'a0'})
    return {id, inserted: true}
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
  /** Aliases whose seat row needs to be materialised inside the main
   *  import tx. Each entry is an alias whose lookup missed against the
   *  live workspace, so `aliasIdMap.get(alias) === computeAliasSeatId(
   *  alias, workspaceId)`. Excludes imported-page hits, daily-note
   *  hits, and existing-block hits — those don't need a new row. */
  aliasesNeedingSeat: string[]
}

/**
 * Pure planning step: build the alias → blockId map without writing
 * anything. Daily-shaped aliases resolve via `dailyNoteBlockId`
 * (deterministic; the row gets materialised lazily by
 * `getOrCreateDailyNote`); existing blocks resolve via the now-indexed
 * `findBlockByAliasInWorkspace`; everything else points at the
 * deterministic alias seat (`computeAliasSeatId`) which the main
 * import tx will materialise idempotently.
 *
 * Why not open per-alias txs anymore: a 5K-alias Roam export spawned
 * 5K side-txs, each firing post-commit processors, row-events tail,
 * handle invalidation, and (in production) one PowerSync upload
 * round-trip. The deterministic-seat scheme matches what
 * parseReferencesProcessor produces, so the seats unify with any
 * pre-existing typed `[[alias]]` stubs and the main-tx
 * parseReferences post-commit becomes a no-op (planned references
 * already match what the processor would compute).
 */
const resolveAliases = async (
  aliases: ReadonlySet<string>,
  recons: PageReconciliation[],
  repo: Repo,
  workspaceId: string,
): Promise<AliasResolution> => {
  const aliasIdMap = new Map<string, string>()
  const aliasesNeedingSeat: string[] = []

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
      // Daily-shaped alias → deterministic id. The row is materialised
      // by getOrCreateDailyNote in step 4 (which also links to the
      // workspace's journal page); we just predict the id here so
      // references[] can be patched in-memory before that call.
      aliasIdMap.set(alias, dailyNoteBlockId(workspaceId, parsedDate.iso))
      continue
    }

    const existing = await repo.findBlockByAliasInWorkspace(workspaceId, alias)
    if (existing) {
      aliasIdMap.set(alias, existing.id)
      continue
    }

    // Unowned alias — point at the deterministic seat
    // (`computeAliasSeatId`). The seat row will be created in the main
    // import tx; if it already exists (from a prior import OR a
    // typed-`[[alias]]` parseReferences run that landed at the same
    // seat), createOrGet leaves it alone. Either way, references in
    // imported content resolve to the same id across runs.
    aliasIdMap.set(alias, computeAliasSeatId(alias, workspaceId))
    aliasesNeedingSeat.push(alias)
  }

  return {aliasIdMap, aliasesNeedingSeat}
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
    // Restoring as an empty stub: clear references and properties too,
    // not just content. The id may have previously been a real imported
    // block whose tombstone left stale references / properties in place;
    // a fresh placeholder must look genuinely fresh, otherwise old
    // backlinks and property values can persist into the upgrade
    // window (and indefinitely if the planned content is also empty).
    await tx.restore(id, {content: '', references: [], properties: {}})
    // Move the restored row to the placeholder location. tx.restore
    // alone keeps parentId / orderKey at whatever they were when the
    // tombstone was created — that may be under a deleted parent or
    // somewhere else entirely, neither of which is a valid spot for
    // an unresolved ((uid)) placeholder. Match the fresh-create branch
    // above: parent_id = NULL, order_key = 'a0'.
    await tx.move(id, {parentId: null, orderKey: 'a0'})
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

/**
 * Fold `key::value` attributes hoisted from a Roam page's direct
 * children onto the live page row with fill-if-missing semantics —
 * an existing local value takes precedence over the imported one
 * (matching the alias-union behavior in `mergeIntoExistingPage`).
 *
 * Used for daily and merging pages, where the row already exists
 * before the import tx and the page-level `composeBlockData` path
 * doesn't run. Non-daily, non-merging pages bake the same attrs
 * into `pageData.properties` at planner time.
 */
const applyPromotedAttributes = async (
  tx: Tx,
  id: string,
  promoted: Record<string, unknown>,
) => {
  const keys = Object.keys(promoted)
  if (keys.length === 0) return
  const existing = await tx.get(id)
  if (!existing) return
  let changed = false
  const next = {...existing.properties}
  for (const k of keys) {
    if (next[k] === undefined) {
      next[k] = promoted[k]
      changed = true
    }
  }
  if (!changed) return
  await tx.update(id, {properties: next})
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
