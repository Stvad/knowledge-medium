/**
 * Per-test Repo lifetime for the shared-db pattern (issue #813).
 *
 * A test Repo is not inert once its test ends. Any `repo.tx` primes the
 * property registry, which schedules a seed-materialization pass, which parks
 * on a `workspace_members` row holding an `onChange` subscription on the SHARED
 * db. A later test inserting that row wakes every parked pass at once, and they
 * write through their own Repo into a database `resetTestDb` has since emptied.
 * That is the flake behind #806/#812/#828 — each fixed in the one file it bit.
 *
 * The scope is opened and closed by global hooks in `src/test/setup.ts`, so
 * every Repo built during a test is released when that test ends, with no
 * per-call-site change across the 246 `createTestRepo` sites. The hook ordering
 * this relies on is fixed by vitest and asserted in `testRepoScope.test.ts`:
 *
 *   file beforeAll → [ SETUP beforeEach → file beforeEach → test →
 *                      file afterEach → SETUP afterEach ] → file afterAll
 *
 * Two consequences worth knowing:
 *
 *  - A Repo built in `beforeAll` (file- or suite-lifetime, by construction) is
 *    registered before any scope is open, so it is NOT released here. That is
 *    deliberate — releasing it would break the file that shares it — and it is
 *    why `createTestDb`'s own teardown is still the right place to cover a
 *    Repo the db outlives.
 *  - A file's own `afterEach` runs BEFORE this release, so a file that already
 *    disposes its Repo keeps working; the second release is a no-op.
 *
 * WEAK REFS, and the sweep. A fuzz property builds one Repo per iteration
 * (`kernelQueries.fuzz.test.ts` does it inside the property callback), and a
 * deep run is bounded by time rather than iteration count — so a strong set
 * would grow without bound inside a single test. Weak refs also select exactly
 * the right Repos for free: one with a parked pass is kept alive by that pass's
 * own subscription, and one that has been collected had nothing left to
 * release. Collection clears a `WeakRef` but leaves its Set entry, so the set
 * alone would still grow with the iteration count; cleared entries are dropped
 * on a doubling watermark, which is amortized O(1) per registration.
 */

import type { Repo } from '@/data/repo'

interface Scope {
  refs: Set<WeakRef<Repo>>
  /** Size at which to drop cleared refs — see the module doc. */
  sweepAt: number
}

const SWEEP_FLOOR = 64

let scope: Scope | null = null

/** Enrol a Repo in the current test's scope, and hand it back — so a harness
 *  that builds one by hand wraps the construction (`trackTestRepo(new Repo(…))`)
 *  rather than remembering a second statement. `createTestRepo` does this for
 *  you; an unenrolled Repo is simply invisible to the release.
 *
 *  A no-op outside a test (module scope, `beforeAll`, `afterAll`), where there
 *  is no scope to close — see the module doc for why that case is left alone. */
export const trackTestRepo = <T extends Repo>(repo: T): T => {
  if (!scope) return repo
  if (scope.refs.size >= scope.sweepAt) {
    for (const ref of scope.refs) if (ref.deref() === undefined) scope.refs.delete(ref)
    scope.sweepAt = Math.max(SWEEP_FLOOR, scope.refs.size * 2)
  }
  scope.refs.add(new WeakRef(repo))
  return repo
}

/** Open a scope. Called from the global `beforeEach`; a second call would
 *  strand the Repos already enrolled, so it refuses rather than overwriting. */
export const beginTestRepoScope = (): void => {
  if (scope) throw new Error('[testRepoScope] a scope is already open')
  scope = {refs: new Set(), sweepAt: SWEEP_FLOOR}
}

/** Release every Repo built during the test and drain its deferred work.
 *
 *  Stopping the observer before unpinning is PRECAUTIONARY — swapping the two
 *  fails no test today. The order is deliberate anyway: unpinning drives
 *  projector work, and a Repo on its way out has no business reacting to it.
 *
 *  Deliberately unguarded, matching `Repo`'s own contract: `pinWorkspace(null)`
 *  returns before the block that throws, so the only way an unpin fails is a
 *  projector disposer throwing during teardown. Catching it per Repo would buy
 *  a partial release on a run that is already red, and costs a worse failure:
 *  a caught unpin leaves the Repo RE-PINNED (the setter rolls back), so the
 *  drain below never settles. */
export const endTestRepoScope = async (): Promise<void> => {
  const closing = scope
  scope = null
  if (!closing) return
  const live = [...closing.refs]
    .map(ref => ref.deref())
    .filter((repo): repo is Repo => repo !== undefined)
  for (const repo of live) {
    repo.stopSyncObserver()
    repo.setActiveWorkspaceId(null)
  }
  await Promise.all(live.map(repo => repo.awaitSeedMaterialization()))
}
