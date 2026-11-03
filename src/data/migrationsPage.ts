/** Migrations-page bootstrap. Thin wrapper around `getOrCreateKernelPage`,
 *  registered as lazy on `systemPagesFacet`, unlike Properties and Types.
 *
 *  Created lazily, by the first claim that needs it (`tryClaim` ensures its
 *  own parent). Two reasons, both worth keeping:
 *   - a workspace that never runs a migration never grows an empty page it
 *     has no use for;
 *   - creation belongs to the operator-triggered migration, so any failure
 *     is reported there rather than silently skipped by bootstrap.
 *
 *  Each WORKSPACE has one, and workspace-scoped is the whole point: it hosts
 *  the `per-graph` backfill claims, which must be visible to every device in
 *  the graph. Anchoring them to a user page instead would make them per-user,
 *  so a second user in a shared workspace would run the same upload-carrying
 *  pass again — the hazard `per-graph` was added to prevent. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { MIGRATIONS_PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreateKernelPage, kernelPageBlockId, type KernelPageSpec } from './kernelPage'

const MIGRATIONS_PAGE_NS = 'f1c0a7e2-5b3d-4a8e-9c1f-2d6b8e4a0c73'
/** Deliberately not `Migrations`: on mature graphs with years of content that
 *  name is often taken — unlike Properties / Types / Recents, which claimed
 *  theirs when graphs were empty. `getOrCreateKernelPage` yields an alias
 *  another live block holds, so a collision would leave this page alias-less
 *  beside the user's own `Migrations` page; the name is one nobody types. */
export const MIGRATIONS_PAGE_ALIAS = 'System Migrations (km)'

export const migrationsPageSpec: KernelPageSpec = {
  namespace: MIGRATIONS_PAGE_NS,
  alias: MIGRATIONS_PAGE_ALIAS,
  markerType: MIGRATIONS_PAGE_TYPE,
}

export const migrationsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, MIGRATIONS_PAGE_NS)

/** `skipUndo`: cmd-Z is never the right gesture for this page. Its only entry
 *  point is `runWorkspaceBackfillNow` — an operator gesture whose own writes
 *  skip undo, and which clears the workspace undo stack on its first committed
 *  batch. But `tryClaim` ensures this parent BEFORE deciding the claim, so the
 *  create also happens on every path where the pass then writes nothing and
 *  clears nothing: a peer already holds the claim, no candidates, an early
 *  throw. Those are exactly the paths where a lone entry would survive — and
 *  the claim block filed under it is `skipUndo` too, so reverting only the
 *  parent orphans it. */
export const getOrCreateMigrationsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, migrationsPageSpec, {skipUndo: true})
