/** Migrations-page bootstrap. Thin wrapper around `getOrCreateKernelPage`,
 *  same shape as the Properties and Types pages.
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
/** Deliberately not `Migrations`. This page is created by `ensureSystemPages`
 *  on the bootstrap critical path, and the alias-uniqueness trigger aborts the
 *  transaction if any live block already holds the name — which, on a mature
 *  graph, would stop the workspace opening at all, unreachably. Unlike
 *  Properties / Types / Recents, this alias is being reserved on graphs that
 *  already have years of content, so it has to be a string nobody has typed. */
const MIGRATIONS_ALIAS = 'System Migrations (km)'

export const migrationsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, MIGRATIONS_PAGE_NS)

export const getOrCreateMigrationsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: MIGRATIONS_PAGE_NS,
    alias: MIGRATIONS_ALIAS,
    markerType: MIGRATIONS_PAGE_TYPE,
  })
