/**
 * New `Repo` class for the data-layer redesign (spec §3, §8).
 *
 * Stage 1.3 scope: holds `db` + `cache` + `user` and exposes `repo.tx`.
 * Mutator / query / processor registries are placeholder fields wired
 * up in stages 1.4+. `setFacetRuntime` is a stub here — the real
 * lifecycle plumbing per §8 lands when those registries become useful.
 *
 * Stage 1.4 will add:
 *   - `repo.mutate.X` typed-dispatch sugar
 *   - `repo.run('name', args)` runtime-validated dispatch
 *   - `repo.indent` / `repo.move` / etc. kernel mutator entry points
 *
 * Stage 2 of Phase 1 (post-1.6) adds:
 *   - HandleStore + `repo.block(id)` / `repo.children(id)` / etc.
 *   - `repo.load(id, opts?)` neighborhood loader
 *   - row_events tail subscription for sync-applied invalidation
 */

import {randomUUID} from 'node:crypto'
import type {
  Mutator,
  RepoTxOptions,
  Tx,
  User,
} from '@/data/api'
import { runTx, type PowerSyncDb } from './commitPipeline'
import type { BlockCache } from '@/data/blockCache'

export interface RepoOptions {
  db: PowerSyncDb
  cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes. UI-state
   *  scope (`local-ui`) is still allowed. Default false. */
  isReadOnly?: boolean
  /** Now provider — default `Date.now`. Injected for test determinism. */
  now?: () => number
  /** UUID provider — default `crypto.randomUUID`. Injected for tests
   *  that want deterministic ids. */
  newId?: () => string
}

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  user: User
  isReadOnly: boolean

  private readonly now: () => number
  private readonly newId: () => string
  private mutators: Map<string, Mutator<unknown, unknown>> = new Map()

  constructor(opts: RepoOptions) {
    this.db = opts.db
    this.cache = opts.cache
    this.user = opts.user
    this.isReadOnly = opts.isReadOnly ?? false
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? randomUUID
  }

  /** Run a transactional session. Spec §3, §10. */
  async tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ): Promise<R> {
    const result = await runTx({
      db: this.db,
      cache: this.cache,
      fn,
      opts,
      user: this.user,
      isReadOnly: this.isReadOnly,
      newTxId: this.newId,
      newId: this.newId,
      now: this.now,
      mutators: this.mutators,
    })
    // afterCommit jobs returned but not dispatched in stage 1.3 — the
    // post-commit processor framework lands in stage 1.5. Until then,
    // we keep them on the result for tests that want to verify
    // scheduling semantics; they don't fire and we don't leak them.
    void result.afterCommitJobs
    return result.value
  }

  /** Stage 1.4 will replace this stub with the real
   *  `setFacetRuntime(runtime)` lifecycle (§8). Stage 1.3 only needs a
   *  way to inject mutators for tx.run testing. */
  __setMutatorsForTesting(mutators: ReadonlyArray<Mutator<unknown, unknown>>): void {
    this.mutators = new Map(mutators.map(m => [m.name, m]))
  }
}
