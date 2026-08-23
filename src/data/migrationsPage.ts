/** Migrations-page bootstrap. Thin wrapper around `getOrCreateKernelPage`,
 *  same shape as the Properties and Types pages — but deliberately NOT
 *  registered on `systemPagesFacet`.
 *
 *  Created lazily, by the first claim that needs it (`tryClaim` ensures its
 *  own parent). Two reasons, both worth keeping:
 *   - a workspace that never runs a migration never grows an empty page it
 *     has no use for;
 *   - `ensureSystemPages` is on the uncaught bootstrap path, so an eager
 *     registration puts this page's alias claim there too, where a collision
 *     stops the workspace opening. Created from inside an operator-triggered
 *     migration instead, a collision fails that migration and says so.
 *
 *  Each WORKSPACE has one, and workspace-scoped is the whole point: it hosts
 *  the `per-graph` backfill claims, which must be visible to every device in
 *  the graph. Anchoring them to a user page instead would make them per-user,
 *  so a second user in a shared workspace would run the same upload-carrying
 *  pass again — the hazard `per-graph` was added to prevent. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { MIGRATIONS_PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreateKernelPage, kernelPageBlockId } from './kernelPage'

const MIGRATIONS_PAGE_NS = 'f1c0a7e2-5b3d-4a8e-9c1f-2d6b8e4a0c73'
/** Deliberately not `Migrations`. The alias-uniqueness trigger aborts the
 *  creating transaction if any live block already holds the name, and this
 *  alias is reserved on mature graphs that already have years of content —
 *  unlike Properties / Types / Recents, which claimed theirs when graphs were
 *  empty. Since creation is lazy (see above), a collision now fails the
 *  operator's migration rather than the workspace open; still worth not
 *  provoking, so the name is one nobody types. */
const MIGRATIONS_ALIAS = 'System Migrations (km)'

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
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: MIGRATIONS_PAGE_NS,
    alias: MIGRATIONS_ALIAS,
    markerType: MIGRATIONS_PAGE_TYPE,
  }, {skipUndo: true})
