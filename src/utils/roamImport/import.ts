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
  type TypeRegistrySnapshot,
  type Tx,
} from '@/data/api'
import { addBlockTypeToProperties, aliasesProp, hasBlockType, typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { dailyNoteBlockId, getOrCreateDailyNote, todayIso } from '@/data/dailyNotes'
import {
  roamTodoStateProp,
  statusProp,
  TODO_TYPE,
  type RoamTodoState,
  type TodoStatus,
} from '@/plugins/todo/schema'
import { SRS_SM25_TYPE } from '@/plugins/srs-rescheduling/schema'
import { computeAliasSeatId } from '../../data/targets'
import { keyAtEnd, keysBetween } from '../../data/orderKey'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'
import type { Repo } from '../../data/repo'
import {
  parseRoamImportReferences,
  planImport,
  type PreparedBlock,
  type PreparedPage,
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
  type RoamImportPlan,
} from './plan'
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

interface RoamTypeMapping {
  readonly typeId: string
  readonly appOwnedInit: Readonly<Record<string, unknown>>
  readonly sourceMirror: Readonly<Record<string, unknown>>
}

const TAG_TO_TYPE: Readonly<Record<RoamTodoState, RoamTypeMapping>> = {
  TODO: {
    typeId: TODO_TYPE,
    appOwnedInit: {[statusProp.name]: 'open' satisfies TodoStatus},
    sourceMirror: {[roamTodoStateProp.name]: 'TODO' satisfies RoamTodoState},
  },
  DONE: {
    typeId: TODO_TYPE,
    appOwnedInit: {[statusProp.name]: 'done' satisfies TodoStatus},
    sourceMirror: {[roamTodoStateProp.name]: 'DONE' satisfies RoamTodoState},
  },
}

const ROAM_SOURCE_PREFIXES = ['roam:']
const PAGE_SOURCE_FIELDS = [aliasesProp.name, typesProp.name]

interface PageReconciliation {
  /** Plan-side blockId; matches data.parentId for direct children. */
  plannedId: string
  /** Final blockId after merge resolution. May equal plannedId. */
  finalId: string
  page: PreparedPage
  /** True when an existing block already owns this title's alias. */
  merging: boolean
  /** True when this exported page is merged into another exported page
   *  because that page declared it through page_alias::[[...]]. */
  aliasRuleMerged: boolean
  /** Canonical exported page title for this reconciliation. */
  rootTitle: string
  /** Alias labels that should be present on the final page row. */
  aliasesToApply: string[]
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

export interface RoamTypeCandidateProperty {
  name: string
  count: number
  percent: number
}

export interface RoamTypeCandidate {
  alias: string
  typeId: string
  count: number
  commonProperties: RoamTypeCandidateProperty[]
}

export interface RoamImportSummary {
  pagesCreated: number
  pagesMerged: number
  pagesDaily: number
  blocksWritten: number
  aliasesResolved: number
  aliasBlocksCreated: number
  typeCandidates: RoamTypeCandidate[]
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
  // Phase-timer helper: each call returns the elapsed seconds since
  // the previous call (or `start`, on first invocation). Including
  // per-phase timings in progress messages turns the log into a
  // crude profiler — useful for telling whether a slow import is
  // stuck in plan / reconcile / write, without needing to attach a
  // devtools profiler to a 5-minute import.
  let phaseStart = start
  const sinceLastPhase = (): string => {
    const now = Date.now()
    const s = ((now - phaseStart) / 1000).toFixed(1)
    phaseStart = now
    return `${s}s`
  }

  log(`Planning ${pages.length} top-level pages…`)
  const plan = planImport(pages, {
    workspaceId: options.workspaceId,
    currentUserId: options.currentUserId,
  })

  log(`Planned ${plan.pages.length} pages, ${plan.descendants.length} descendant blocks, ` +
    `${plan.aliasesUsed.size} aliases, ${plan.placeholders.length} placeholders ` +
    `(${sinceLastPhase()})`)

  // 1. Reconcile pages against the live workspace so we know which
  //    plannedIds get rerouted to existing alias-pages.
  log(`Reconciling ${plan.pages.length} pages against existing workspace…`)
  const reconciliations = await reconcilePages(
    plan.pages,
    repo,
    options.workspaceId,
    plan.diagnostics,
    log,
  )
  const reparentMap = buildReparentMap(reconciliations)
  log(`Reconciled ${reconciliations.length} pages ` +
    `(${reconciliations.filter(r => r.merging).length} merge into existing) (${sinceLastPhase()})`)

  // 2. Build alias → blockId map for every alias mentioned in content.
  //    Pure planning — no DB writes here. Seat-materialisation for
  //    unowned aliases happens inside the main tx in step 5b.
  log(`Resolving ${plan.aliasesUsed.size} aliases…`)
  const aliasResolution = await resolveAliases(
    plan.aliasesUsed,
    reconciliations,
    repo,
    options.workspaceId,
    log,
  )
  log(`Resolved ${aliasResolution.aliasIdMap.size} aliases ` +
    `(${aliasResolution.aliasesNeedingSeat.length} need new seat rows) (${sinceLastPhase()})`)

  // 3. Patch references[] on every block with the alias rows.
  for (const desc of plan.descendants) {
    patchAliasReferences(desc.data, aliasResolution.aliasIdMap)
  }
  for (const page of plan.pages) {
    if (page.data) patchAliasReferences(page.data, aliasResolution.aliasIdMap)
  }
  log(`Patched references on ${plan.descendants.length + plan.pages.length} blocks (${sinceLastPhase()})`)

  const typeSnapshot = repo.snapshotTypeRegistries()
  const typeCandidates = collectTypeCandidates(plan, typeSnapshot.types)
  if (typeCandidates.length > 0) {
    log(`Found ${typeCandidates.length} isa:: type candidates`)
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
      typeCandidates,
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
  const dailyIsos = collectDailyIsos(
    reconciliations,
    aliasResolution.aliasIdMap,
    plan.aliasesUsed,
    plan.diagnostics,
  )
  if (dailyIsos.length > 0) log(`Materialising ${dailyIsos.length} daily notes…`)
  // Throttle progress to every 100 dailies — emitting per-iteration
  // would flood any UI banner with redraws when an export references
  // years of dailies.
  //
  // Per-iso failure isolation: a single bad iso (e.g. one that slipped
  // past the perimeter shape filter for some reason we haven't seen
  // yet) shouldn't sink an otherwise-successful import. Catch, log to
  // diagnostics, continue.
  for (let i = 0; i < dailyIsos.length; i++) {
    const iso = dailyIsos[i]
    try {
      await getOrCreateDailyNote(repo, options.workspaceId, iso)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      plan.diagnostics.push(`Failed to materialise daily note for ${iso}: ${message}`)
      log(`Daily note ${iso} failed: ${message} — continuing`)
    }
    if ((i + 1) % 100 === 0 && i + 1 < dailyIsos.length) {
      log(`Daily notes ${i + 1}/${dailyIsos.length}`)
    }
  }
  if (dailyIsos.length > 0) log(`Materialised ${dailyIsos.length} daily notes (${sinceLastPhase()})`)

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
    //     shape as backlinks.parseReferences' ensureAliasTarget — at
    //     the deterministic id, with `aliases: [alias]` on insert /
    //     restore. A live row at the seat (e.g. created earlier by
    //     parseReferences when the user typed `[[alias]]` before
    //     importing) is left alone; tombstones restore. The legacy
    //     code wrote `content: alias` so the imported alias-block had
    //     a visible title — preserved here for UI parity (user types
    //     `[[Foo]]` → empty stub; Roam imports `[[Foo]]` → "Foo"
    //     content for findability).
    for (const alias of aliasResolution.aliasesNeedingSeat) {
      const result = await ensureAliasSeat(
        tx,
        repo,
        {alias, workspaceId: options.workspaceId},
        typeSnapshot,
      )
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
    const rootReconciliations = reconciliations.filter(r => !r.aliasRuleMerged)
    const aliasRuleMergedReconciliations = reconciliations.filter(r => r.aliasRuleMerged)

    for (const recon of rootReconciliations) {
      if (recon.page.isDaily) {
        await mergePageAliases(tx, recon.finalId, recon.aliasesToApply)
        await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren)
        continue
      }
      if (recon.merging) {
        pagesMerged += 1
        await mergeIntoExistingPage(tx, recon, repo, typeSnapshot)
        await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren)
        continue
      }
      pagesCreated += 1
      if (!recon.page.data) throw new Error('Non-daily, non-merging page must have data')
      await upsertImportedBlock(
        tx,
        withPageAliases(recon.page.data, recon.aliasesToApply),
        pageImportMergeOptions(),
      )
    }

    for (const recon of aliasRuleMergedReconciliations) {
      if (!recon.page.isDaily) pagesMerged += 1
      await mergePageAliases(tx, recon.finalId, recon.aliasesToApply)
      await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'roam import: pages'})

  log(`Wrote frontmatter: ${plan.placeholders.length} placeholders, ` +
    `${pagesCreated} new pages, ${pagesMerged} merged, ${pagesDaily} daily-notes, ` +
    `${aliasBlocksCreated} alias seats (${sinceLastPhase()})`)

  // 5d. Descendants in chunks. Planner emits them in post-order
  //     (leaves before parents); we walk in reverse so each
  //     descendant's parent is already committed (either from
  //     frontmatter tx above, or from an earlier descendant chunk).
  //     A parent + child split across two chunks is safe — the
  //     parent commits first, the child sees it via the workspace-
  //     invariant trigger's committed-state read.
  const total = plan.descendants.length
  const chunkSize = options.descendantChunkSize ?? DESCENDANT_CHUNK_SIZE
  const descendantsStart = Date.now()
  let written = 0
  for (let chunkStart = total - 1; chunkStart >= 0; chunkStart -= chunkSize) {
    const chunkEnd = Math.max(0, chunkStart - chunkSize + 1)
    const chunkBeganAt = Date.now()
    await repo.tx(async tx => {
      for (let i = chunkStart; i >= chunkEnd; i--) {
        const desc = plan.descendants[i]
        const data = applyReparent(desc.data, reparentMap)
        await upsertImportedBlock(tx, data, mergeOptionsForDescendant(desc))
        await applyMappedTypesInTx(tx, desc, repo, typeSnapshot)
      }
    }, {scope: ChangeScope.BlockDefault, description: 'roam import: descendants'})
    const chunkRows = chunkStart - chunkEnd + 1
    written += chunkRows
    const chunkSec = (Date.now() - chunkBeganAt) / 1000
    const elapsedSec = (Date.now() - descendantsStart) / 1000
    const rate = elapsedSec > 0 ? written / elapsedSec : 0
    const remaining = total - written
    const etaSec = rate > 0 ? remaining / rate : 0
    log(`Wrote descendants ${written}/${total} ` +
      `(chunk ${chunkRows} rows in ${chunkSec.toFixed(1)}s, ` +
      `${rate.toFixed(0)} rows/s, eta ~${formatEta(etaSec)})`)
  }
  if (total > 0) log(`All ${total} descendants written (${sinceLastPhase()})`)

  // 6. Append a one-block import log under today's daily-note. Diagnostics
  //    that the planner / orchestrator surfaced (deep property nesting,
  //    placeholders, etc.) become sub-bullets so the user has a
  //    findable record of anything weird without grepping the console.
  //    Per-import failure isolation: a broken log write (e.g. corrupt
  //    daily-note row) shouldn't fail the whole import — the data has
  //    already landed. Catch and surface via the progress callback.
  try {
    await writeImportLog(repo, options.workspaceId, {
      pagesCreated,
      pagesMerged,
      pagesDaily,
      blocksWritten: plan.descendants.length,
      placeholdersCreated: plan.placeholders.length,
      aliasBlocksCreated,
      typeCandidates,
      durationMs: Date.now() - start,
      diagnostics: plan.diagnostics,
    })
    log(`Wrote import-log block to today's daily (${sinceLastPhase()})`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`Could not write import-log block: ${message}`)
  }

  return {
    pagesCreated,
    pagesMerged,
    pagesDaily,
    blocksWritten: plan.descendants.length,
    aliasesResolved: aliasResolution.aliasIdMap.size,
    aliasBlocksCreated,
    typeCandidates,
    placeholdersCreated: plan.placeholders.length,
    diagnostics: plan.diagnostics,
    durationMs: Date.now() - start,
    dryRun: false,
  }
}

interface TypeCandidateAccumulator {
  alias: string
  typeId: string
  count: number
  propCounts: Map<string, number>
}

const TYPE_CANDIDATE_EXCLUDED_PROPERTIES = new Set([
  aliasesProp.name,
  typesProp.name,
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
])

const MAX_TYPE_CANDIDATES_IN_REPORT = 20
const MAX_COMMON_PROPS_IN_REPORT = 5

const typeIdFromIsaAlias = (alias: string): string => {
  const slug = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || alias.trim()
}

const collectIsaAliases = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return uniqueNonEmpty(value.flatMap(collectIsaAliases))
  }
  if (typeof value !== 'string') return []

  const trimmed = value.trim()
  if (trimmed.length === 0) return []

  const parsed = parseRoamImportReferences(trimmed).map(ref => ref.alias)
  if (parsed.length > 0) return uniqueNonEmpty(parsed)

  const unwrapped = /^\[\[(.+)]]$/.exec(trimmed)?.[1]?.trim()
  return [unwrapped ?? trimmed]
}

const uniqueNonEmpty = (values: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const reportablePropertyNames = (properties: Record<string, unknown>): string[] =>
  Object.keys(properties)
    .filter(name =>
      !TYPE_CANDIDATE_EXCLUDED_PROPERTIES.has(name) &&
      properties[name] !== undefined,
    )

const addTypeCandidateSource = (
  groups: Map<string, TypeCandidateAccumulator>,
  registeredTypes: ReadonlyMap<string, unknown>,
  properties: Record<string, unknown>,
) => {
  const aliases = collectIsaAliases(properties[ROAM_ISA_PROP])
  if (aliases.length === 0) return
  const props = reportablePropertyNames(properties)

  for (const alias of aliases) {
    const typeId = typeIdFromIsaAlias(alias)
    if (registeredTypes.has(typeId) || registeredTypes.has(alias)) continue

    let group = groups.get(alias)
    if (!group) {
      group = {alias, typeId, count: 0, propCounts: new Map()}
      groups.set(alias, group)
    }
    group.count += 1
    for (const prop of props) {
      group.propCounts.set(prop, (group.propCounts.get(prop) ?? 0) + 1)
    }
  }
}

const collectTypeCandidates = (
  plan: RoamImportPlan,
  registeredTypes: ReadonlyMap<string, unknown>,
): RoamTypeCandidate[] => {
  const groups = new Map<string, TypeCandidateAccumulator>()

  for (const page of plan.pages) {
    const properties = page.data?.properties ?? page.promotedFromChildren
    addTypeCandidateSource(groups, registeredTypes, properties)
  }
  for (const desc of plan.descendants) {
    addTypeCandidateSource(groups, registeredTypes, desc.data.properties)
  }

  return [...groups.values()]
    .map(group => {
      const minCommonCount = group.count === 1
        ? 1
        : Math.max(2, Math.ceil(group.count * 0.15))
      const commonProperties = [...group.propCounts.entries()]
        .filter(([, count]) => count >= minCommonCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_COMMON_PROPS_IN_REPORT)
        .map(([name, count]) => ({
          name,
          count,
          percent: Math.round((count / group.count) * 100),
        }))
      return {
        alias: group.alias,
        typeId: group.typeId,
        count: group.count,
        commonProperties,
      }
    })
    .sort((a, b) => b.count - a.count || a.alias.localeCompare(b.alias))
}

const formatTypeCandidateReport = (
  candidates: ReadonlyArray<RoamTypeCandidate>,
): string[] => {
  const lines = candidates.slice(0, MAX_TYPE_CANDIDATES_IN_REPORT).map(candidate => {
    const nodeLabel = candidate.count === 1
      ? '1 node'
      : `${candidate.count} nodes`
    const props = candidate.commonProperties.length > 0
      ? candidate.commonProperties
        .map(prop => `${prop.name} ${prop.count}/${candidate.count} (${prop.percent}%)`)
        .join(', ')
      : 'no recurring props'
    return `[[${candidate.alias}]] -> type "${candidate.typeId}" (${nodeLabel}); common props: ${props}`
  })

  if (candidates.length > MAX_TYPE_CANDIDATES_IN_REPORT) {
    lines.push(`${candidates.length - MAX_TYPE_CANDIDATES_IN_REPORT} more isa:: candidates omitted from this report.`)
  }

  return lines
}

interface ImportLogStats {
  pagesCreated: number
  pagesMerged: number
  pagesDaily: number
  blocksWritten: number
  placeholdersCreated: number
  aliasBlocksCreated: number
  typeCandidates: ReadonlyArray<RoamTypeCandidate>
  durationMs: number
  diagnostics: ReadonlyArray<string>
}

/**
 * Append a one-parent + N-children block to today's daily-note that
 * records the just-finished import. Header summarises counts; each
 * diagnostic becomes a sub-bullet.
 *
 * The header is parented under the daily-note row at the end of its
 * existing children (via `keyAtEnd`). The user's existing bullets
 * keep their order; the log lands below them. Sub-bullets get jittered
 * keys via `keysBetween(null, null, n)` since the header is fresh
 * (no neighbors yet).
 */
const writeImportLog = async (
  repo: Repo,
  workspaceId: string,
  stats: ImportLogStats,
): Promise<void> => {
  const iso = todayIso()
  // Make sure today's daily-note row exists. Idempotent — if today's
  // import already touched it, this is a cache hit.
  await getOrCreateDailyNote(repo, workspaceId, iso)
  const dailyId = dailyNoteBlockId(workspaceId, iso)
  const typeCandidateLines = formatTypeCandidateReport(stats.typeCandidates)
  const typeCandidateSummary = stats.typeCandidates.length > 0
    ? `, ${stats.typeCandidates.length} type candidates`
    : ''

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const headerContent =
    `Roam import ${stamp}: ` +
    `${stats.pagesCreated} new pages, ${stats.pagesMerged} merged, ` +
    `${stats.pagesDaily} daily, ${stats.blocksWritten} blocks ` +
    `(${stats.placeholdersCreated} placeholders, ` +
    `${stats.aliasBlocksCreated} alias seats, ` +
    `${stats.diagnostics.length} notes${typeCandidateSummary}, ` +
    `${(stats.durationMs / 1000).toFixed(1)}s)`

  await repo.tx(async tx => {
    const existing = await tx.childrenOf(dailyId, workspaceId)
    const lastKey = existing.length > 0
      ? existing[existing.length - 1].orderKey
      : null
    const headerOrderKey = keyAtEnd(lastKey)

    const headerId = await tx.create({
      workspaceId,
      parentId: dailyId,
      orderKey: headerOrderKey,
      content: headerContent,
    })

    const childCount = stats.diagnostics.length + (typeCandidateLines.length > 0 ? 1 : 0)
    if (childCount === 0) return
    const childKeys = keysBetween(null, null, childCount)
    let childIndex = 0
    for (let i = 0; i < stats.diagnostics.length; i++) {
      await tx.create({
        workspaceId,
        parentId: headerId,
        orderKey: childKeys[childIndex++],
        content: stats.diagnostics[i],
      })
    }
    if (typeCandidateLines.length > 0) {
      const sectionId = await tx.create({
        workspaceId,
        parentId: headerId,
        orderKey: childKeys[childIndex],
        content: 'Type candidates from isa::',
      })
      const sectionKeys = keysBetween(null, null, typeCandidateLines.length)
      for (let i = 0; i < typeCandidateLines.length; i++) {
        await tx.create({
          workspaceId,
          parentId: sectionId,
          orderKey: sectionKeys[i],
          content: typeCandidateLines[i],
        })
      }
    }
  }, {scope: ChangeScope.BlockDefault, description: 'roam import: log'})
}

// Render a remaining-seconds estimate as e.g. "12s", "1m20s", "1h05m".
// Resolution drops to coarser units past 60s so the message stays
// short — chunked-import progress lines are already busy.
const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '?'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h${String(m).padStart(2, '0')}m`
}

// Strict ISO yyyy-mm-dd shape — same regex `dailyNotes.parseIsoParts`
// uses. Anything that doesn't match crashes the daily-note path, so we
// drop it at the perimeter rather than letting a single typo'd page
// abort the entire import.
const VALID_ISO = /^\d{4}-\d{2}-\d{2}$/

/** Distinct ISO dates that need a daily-note row before the main tx
 *  commits — the union of (imported daily pages, daily-shaped aliases
 *  referenced in content). Deduplicated so a 1000-block import that
 *  references `[[2026-04-28]]` 500 times calls getOrCreateDailyNote
 *  once per unique date, not once per occurrence.
 *
 *  Defensive iso-shape filter at the perimeter: any iso that fails the
 *  strict regex would crash `getOrCreateDailyNote`, killing the whole
 *  import for one bad page. Drop it here and surface it via
 *  `diagnostics`, mirroring how the planner handles other lossy
 *  fallbacks. */
const collectDailyIsos = (
  recons: PageReconciliation[],
  aliasIdMap: AliasIdMap,
  aliasesUsed: ReadonlySet<string>,
  diagnostics: string[],
): string[] => {
  const isos = new Set<string>()
  for (const r of recons) {
    if (!r.page.isDaily || !r.page.iso) continue
    if (!VALID_ISO.test(r.page.iso)) {
      // Should not happen — the three upstream paths
      // (`isoFromDateUid`, `isoFromLogId`, `parseLiteralDailyPageTitle`)
      // all clamp to 4-digit years already. This branch is a defensive
      // safety net so a future regression at any of those sources
      // doesn't crash the entire import.
      diagnostics.push(
        `Daily page "${r.page.title}" (uid ${r.page.roamUid}) has non-standard ` +
        `ISO "${r.page.iso}"; skipping daily-note materialisation. The page row ` +
        `will still be created, but downstream steps may fail — investigate the ` +
        `source data or upstream resolveDailyPage path.`,
      )
      continue
    }
    isos.add(r.page.iso)
  }
  for (const alias of aliasesUsed) {
    // Must match the literal-only filter resolveAliases uses — otherwise
    // we'd materialise daily-note rows for aliases we never rewired to a
    // daily-note id (e.g. `[[today]]`), wasting work and creating empty
    // daily-page rows that nothing references.
    const parsed = parseLiteralDailyPageTitle(alias)
    if (!parsed || !aliasIdMap.has(alias)) continue
    if (!VALID_ISO.test(parsed.iso)) {
      diagnostics.push(`Alias "${alias}" parsed to non-standard ISO "${parsed.iso}" — skipping.`)
      continue
    }
    isos.add(parsed.iso)
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
  repo: Repo,
  {alias, workspaceId}: {alias: string; workspaceId: string},
  typeSnapshot: TypeRegistrySnapshot,
): Promise<{ id: string; inserted: boolean }> => {
  const id = computeAliasSeatId(alias, workspaceId)
  const properties = {
    [aliasesProp.name]: aliasesProp.codec.encode([alias]),
  }
  try {
    const result = await tx.createOrGet({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: alias,
      properties,
    })
    if (result.inserted) {
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [alias]}, typeSnapshot)
    }
    return result
  } catch (err) {
    if (!(err instanceof DeletedConflictError)) throw err
    await tx.restore(id, {content: alias, properties, references: []})
    await tx.move(id, {parentId: null, orderKey: 'a0'})
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [alias]}, typeSnapshot)
    return {id, inserted: true}
  }
}

interface PageAliasRulePlan {
  rootByTitle: Map<string, string>
  aliasesByRootTitle: Map<string, string[]>
  diagnostics: string[]
}

const uniqueStrings = (values: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const quotedList = (values: readonly string[]): string => {
  const quoted = values.map(value => `'${value}'`)
  if (quoted.length <= 2) return quoted.join(' and ')
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`
}

const buildPageAliasRulePlan = (
  preparedPages: RoamImportPlan['pages'],
): PageAliasRulePlan => {
  const directOwnerByAlias = new Map<string, string>()
  const diagnostics: string[] = []
  const pageOrder = new Map(preparedPages.map((page, index) => [page.title, index]))

  for (const page of preparedPages) {
    for (const alias of uniqueStrings(page.pageAliases)) {
      if (alias === page.title) continue
      const existingOwner = directOwnerByAlias.get(alias)
      if (existingOwner && existingOwner !== page.title) {
        diagnostics.push(
          `Page alias "${alias}" was claimed by both [[${existingOwner}]] and ` +
          `[[${page.title}]]; keeping [[${existingOwner}]].`,
        )
        continue
      }
      directOwnerByAlias.set(alias, page.title)
    }
  }

  const rootCache = new Map<string, string>()
  const chooseCycleRoot = (cycle: readonly string[]): string =>
    [...cycle].sort((a, b) => {
      const aOrder = pageOrder.get(a) ?? Number.MAX_SAFE_INTEGER
      const bOrder = pageOrder.get(b) ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.localeCompare(b)
    })[0]

  const rootFor = (title: string): string => {
    const cached = rootCache.get(title)
    if (cached) return cached

    const path: string[] = []
    const seen = new Map<string, number>()
    let current = title

    const remember = (root: string): string => {
      for (const titleInPath of path) rootCache.set(titleInPath, root)
      return root
    }

    while (true) {
      const cachedCurrent = rootCache.get(current)
      if (cachedCurrent) {
        return remember(cachedCurrent)
      }

      const seenAt = seen.get(current)
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt)
        const root = chooseCycleRoot(cycle)
        diagnostics.push(
          `page_alias cycle involving ${cycle.map(t => `[[${t}]]`).join(', ')}; ` +
          `using [[${root}]] as the canonical page.`,
        )
        return remember(root)
      }

      seen.set(current, path.length)
      path.push(current)

      const owner = directOwnerByAlias.get(current)
      if (!owner || owner === current) {
        return remember(current)
      }
      current = owner
    }
  }

  const rootByTitle = new Map<string, string>()
  const pageByTitle = new Map(preparedPages.map(page => [page.title, page]))
  for (const page of preparedPages) {
    rootByTitle.set(page.title, rootFor(page.title))
  }

  const aliasesByRootTitle = new Map<string, string[]>()
  const mergedTitlesByRootTitle = new Map<string, string[]>()

  for (const page of preparedPages) {
    const root = rootByTitle.get(page.title) ?? page.title
    if (root !== page.title) continue

    const aliases: string[] = [page.title]
    const visitedPages = new Set<string>()
    const visit = (source: PreparedPage) => {
      if (visitedPages.has(source.title)) return
      visitedPages.add(source.title)

      for (const alias of uniqueStrings(source.pageAliases)) {
        if (alias !== source.title && directOwnerByAlias.get(alias) !== source.title) continue
        aliases.push(alias)

        const aliasPage = pageByTitle.get(alias)
        if (aliasPage && rootByTitle.get(aliasPage.title) === root) {
          visit(aliasPage)
        }
      }
    }

    visit(page)
    const uniqueAliases = uniqueStrings(aliases)
    aliasesByRootTitle.set(root, uniqueAliases)

    const merged = uniqueAliases.filter(alias => {
      if (alias === root) return false
      const aliasPage = pageByTitle.get(alias)
      return Boolean(aliasPage && rootByTitle.get(aliasPage.title) === root)
    })
    if (merged.length > 0) {
      mergedTitlesByRootTitle.set(root, merged)
    }
  }

  for (const [root, mergedTitles] of mergedTitlesByRootTitle) {
    diagnostics.push(
      `[[${root}]] also had ${quotedList(mergedTitles)} merged in bc of the alias rule`,
    )
  }

  return {rootByTitle, aliasesByRootTitle, diagnostics}
}

const lookupExistingPageByAliases = async (
  repo: Repo,
  workspaceId: string,
  aliases: readonly string[],
): Promise<BlockData | null> => {
  for (const alias of aliases) {
    const existing = await repo.query.aliasLookup({workspaceId, alias}).load()
    if (existing && hasBlockType(existing, PAGE_TYPE)) return existing
  }
  return null
}

const reconcilePages = async (
  preparedPages: RoamImportPlan['pages'],
  repo: Repo,
  workspaceId: string,
  diagnostics: string[],
  log?: (msg: string) => void,
): Promise<PageReconciliation[]> => {
  const aliasRule = buildPageAliasRulePlan(preparedPages)
  diagnostics.push(...aliasRule.diagnostics)

  const rootRecons = new Map<string, PageReconciliation>()
  for (const page of preparedPages) {
    const rootTitle = aliasRule.rootByTitle.get(page.title) ?? page.title
    if (rootTitle !== page.title) continue

    const aliasesToApply = aliasRule.aliasesByRootTitle.get(rootTitle) ?? [page.title]
    if (page.isDaily) {
      rootRecons.set(rootTitle, {
        plannedId: page.blockId,
        finalId: page.blockId,
        page,
        merging: false,
        aliasRuleMerged: false,
        rootTitle,
        aliasesToApply,
      })
      continue
    }

    const existing = await lookupExistingPageByAliases(repo, workspaceId, aliasesToApply)
    rootRecons.set(rootTitle, {
      plannedId: page.blockId,
      finalId: existing?.id ?? page.blockId,
      page,
      merging: Boolean(existing),
      aliasRuleMerged: false,
      rootTitle,
      aliasesToApply,
    })
  }

  const out: PageReconciliation[] = []
  for (let i = 0; i < preparedPages.length; i++) {
    const page = preparedPages[i]
    const rootTitle = aliasRule.rootByTitle.get(page.title) ?? page.title
    const rootRecon = rootRecons.get(rootTitle)
    if (!rootRecon) {
      throw new Error(`reconcilePages: missing root reconciliation for ${rootTitle}`)
    }

    if (rootTitle === page.title) {
      out.push(rootRecon)
    } else {
      out.push({
        plannedId: page.blockId,
        finalId: rootRecon.finalId,
        page,
        merging: true,
        aliasRuleMerged: true,
        rootTitle,
        aliasesToApply: rootRecon.aliasesToApply,
      })
    }
    if (log && (i + 1) % 100 === 0 && i + 1 < preparedPages.length) {
      log(`Reconciled ${i + 1}/${preparedPages.length} pages`)
    }
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
 * backlinks.parseReferences produces, so the seats unify with any
 * pre-existing typed `[[alias]]` stubs and the main-tx
 * parseReferences post-commit becomes a no-op (planned references
 * already match what the processor would compute).
 */
const resolveAliases = async (
  aliases: ReadonlySet<string>,
  recons: PageReconciliation[],
  repo: Repo,
  workspaceId: string,
  log?: (msg: string) => void,
): Promise<AliasResolution> => {
  const aliasIdMap = new Map<string, string>()
  const aliasesNeedingSeat: string[] = []

  // First, alias = imported-page-title shortcuts to that page's final id
  // or page_alias-derived alias shortcuts to that page's final id
  // (covers references between imported pages, merge-into-existing,
  // and aliases whose target page is not separately present in the
  // export).
  const importedPagesByTitle = new Map<string, string>()
  for (const r of recons) {
    importedPagesByTitle.set(r.page.title, r.finalId)
    for (const alias of r.aliasesToApply) {
      if (!importedPagesByTitle.has(alias)) importedPagesByTitle.set(alias, r.finalId)
    }
  }

  const total = aliases.size
  let processed = 0
  for (const alias of aliases) {
    const importedHit = importedPagesByTitle.get(alias)
    if (importedHit) {
      aliasIdMap.set(alias, importedHit)
    } else {
      const parsedDate = parseLiteralDailyPageTitle(alias)
      if (parsedDate) {
        // Daily-shaped alias → deterministic id. The row is materialised
        // by getOrCreateDailyNote in step 4 (which also links to the
        // workspace's journal page); we just predict the id here so
        // references[] can be patched in-memory before that call.
        //
        // Strict literal-only check (not parseRelativeDate): chrono.casual
        // resolves "today" / "now" / "may" / "friday" to the *current*
        // day, so a permissive parser would rewire every historical
        // `[[today]]` into today's daily-note id at import time and
        // bloat today's backlinks with every block that ever mentioned
        // a relative-time word. Roam's own behavior is that `[[today]]`
        // is a regular page named "today", not the day's daily.
        aliasIdMap.set(alias, dailyNoteBlockId(workspaceId, parsedDate.iso))
      } else {
        const existing = await repo.query.aliasLookup({workspaceId, alias}).load()
        if (existing) {
          aliasIdMap.set(alias, existing.id)
        } else {
          // Unowned alias — point at the deterministic seat
          // (`computeAliasSeatId`). The seat row will be created in the
          // main import tx; if it already exists (from a prior import
          // OR a typed-`[[alias]]` parseReferences run that landed at
          // the same seat), createOrGet leaves it alone. Either way,
          // references in imported content resolve to the same id
          // across runs.
          aliasIdMap.set(alias, computeAliasSeatId(alias, workspaceId))
          aliasesNeedingSeat.push(alias)
        }
      }
    }
    processed += 1
    if (log && processed % 200 === 0 && processed < total) {
      log(`Resolved ${processed}/${total} aliases`)
    }
  }

  return {aliasIdMap, aliasesNeedingSeat}
}

const patchAliasReferences = (data: BlockData, aliasIdMap: AliasIdMap) => {
  const parsed = parseRoamImportReferences(data.content)
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

interface ImportPropertyMergeOptions {
  readonly appOwnedFields?: readonly string[]
  readonly sourceFields?: readonly string[]
  readonly sourcePrefixes?: readonly string[]
}

const pageImportMergeOptions = (): ImportPropertyMergeOptions => ({
  sourceFields: PAGE_SOURCE_FIELDS,
  sourcePrefixes: ROAM_SOURCE_PREFIXES,
})

const todoMappingFor = (desc: PreparedBlock): RoamTypeMapping | undefined =>
  desc.todoState ? TAG_TO_TYPE[desc.todoState] : undefined

const mergeOptionsForDescendant = (
  desc: PreparedBlock,
): ImportPropertyMergeOptions => {
  const mapping = todoMappingFor(desc)
  return {
    appOwnedFields: mapping ? Object.keys(mapping.appOwnedInit) : [],
    sourcePrefixes: ROAM_SOURCE_PREFIXES,
  }
}

const hasOwn = (
  obj: Record<string, unknown>,
  key: string,
): boolean => Object.prototype.hasOwnProperty.call(obj, key)

const mergeImportedProperties = (
  existing: Record<string, unknown>,
  planned: Record<string, unknown>,
  options: ImportPropertyMergeOptions = {},
): Record<string, unknown> => {
  const appOwned = new Set(options.appOwnedFields ?? [])
  const sourceFields = new Set<string>([
    ...Object.keys(planned),
    ...(options.sourceFields ?? []),
  ])
  const sourcePrefixes = options.sourcePrefixes ?? []

  for (const key of Object.keys(existing)) {
    if (sourcePrefixes.some(prefix => key.startsWith(prefix))) {
      sourceFields.add(key)
    }
  }

  const keys = new Set([
    ...Object.keys(existing),
    ...Object.keys(planned),
    ...sourceFields,
  ])
  const next: Record<string, unknown> = {}

  for (const key of keys) {
    const existingHas = hasOwn(existing, key)
    const plannedHas = hasOwn(planned, key)

    if (appOwned.has(key)) {
      if (existingHas) next[key] = existing[key]
      else if (plannedHas) next[key] = planned[key]
      continue
    }

    if (sourceFields.has(key)) {
      if (plannedHas) next[key] = planned[key]
      continue
    }

    if (existingHas) next[key] = existing[key]
    else if (plannedHas) next[key] = planned[key]
  }

  return next
}

const applyMappedTypesInTx = async (
  tx: Tx,
  desc: PreparedBlock,
  repo: Repo,
  typeSnapshot: TypeRegistrySnapshot,
): Promise<void> => {
  const mapping = todoMappingFor(desc)
  if (mapping) {
    await repo.addTypeInTx(tx, desc.data.id, mapping.typeId, mapping.appOwnedInit, typeSnapshot)
    const roamTodoState = mapping.sourceMirror[roamTodoStateProp.name] as RoamTodoState | undefined
    if (roamTodoState) {
      await tx.setProperty(desc.data.id, roamTodoStateProp, roamTodoState)
    }
  }

  if (desc.srsSchedule) {
    await repo.addTypeInTx(tx, desc.data.id, SRS_SM25_TYPE, {}, typeSnapshot)
  }
}

/**
 * Insert a planned block, OR upgrade an existing row at the same id.
 *
 * Three branches:
 *   - Fresh insert (createOrGet returns inserted=true): nothing else
 *     to do — the row was written with the planned data.
 *   - Live-row hit (inserted=false): apply the planned content /
 *     references and the planned/source-owned property subset via
 *     tx.update, then re-parent via tx.move so a prior placeholder
 *     gets upgraded.
 *   - Tombstone hit (createOrGet throws DeletedConflictError):
 *     tx.restore writes deleted=0 + the data-field patch in one
 *     UPDATE; tx.move handles parent_id + order_key. Without this
 *     branch a re-import of a previously-deleted Roam block / page
 *     would crash the entire import tx.
 *
 * Live-row content + references remain source-authoritative. Properties
 * merge by ownership: planned/importer source fields refresh, app-owned
 * type fields initialise only when missing, and unrelated local fields
 * survive. Tombstones still resurrect with the planned data rather than
 * the user's pre-deletion state.
 */
const upsertImportedBlock = async (
  tx: Tx,
  data: NewBlockData & {id: string; content: string},
  propertyMergeOptions: ImportPropertyMergeOptions = {},
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
    const existing = await tx.get(data.id)
    if (!existing) throw new Error(`upsertImportedBlock: existing block ${data.id} not found`)
    const properties = mergeImportedProperties(
      existing.properties,
      data.properties ?? {},
      propertyMergeOptions,
    )
    await tx.update(data.id, {
      content: data.content,
      properties,
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

const withPageAliases = (
  data: NewBlockData & {id: string; content: string},
  aliases: readonly string[],
): NewBlockData & {id: string; content: string} => ({
  ...data,
  properties: addBlockTypeToProperties({
    ...(data.properties ?? {}),
    [aliasesProp.name]: aliasesProp.codec.encode(uniqueStrings(aliases)),
  }, PAGE_TYPE),
})

const mergePageAliases = async (
  tx: Tx,
  id: string,
  aliasesToApply: readonly string[],
) => {
  const existing = await tx.get(id)
  if (!existing) return

  const currentValue = existing.properties[aliasesProp.name]
  const current = Array.isArray(currentValue)
    ? currentValue.filter((v): v is string => typeof v === 'string')
    : []
  const next = uniqueStrings([...current, ...aliasesToApply])
  if (next.length === current.length && next.every((alias, index) => alias === current[index])) return

  await tx.setProperty(id, aliasesProp, next)
}

const mergeIntoExistingPage = async (
  tx: Tx,
  recon: PageReconciliation,
  repo: Repo,
  typeSnapshot = repo.snapshotTypeRegistries(),
) => {
  const existing = await tx.get(recon.finalId)
  if (!existing) {
    throw new Error(`mergeIntoExistingPage: existing page ${recon.finalId} not found`)
  }
  // Make sure the existing page records all imported aliases too —
  // Roam can have aliases the local block doesn't know about. If they
  // already appear, this is a no-op.
  await mergePageAliases(tx, recon.finalId, recon.aliasesToApply)
  await repo.addTypeInTx(tx, recon.finalId, PAGE_TYPE, {}, typeSnapshot)
  // Descendants are already routed under recon.finalId via the
  // reparentMap (their parentId was rewritten before tx.createOrGet).
  // No explicit child-list manipulation needed in the new shape.
}
