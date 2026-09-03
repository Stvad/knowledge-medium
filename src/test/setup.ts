import { afterEach, beforeEach } from 'vitest'
import { beginTestRepoScope, endTestRepoScope } from '@/data/test/testRepoScope'
import { setDevAssertionsEnabled } from '@/data/internals/devAssertions'

// jest-dom's matchers only matter where a DOM exists; loading it in the ~370
// node-env files costs ~23ms each of pure setup-phase waste. The /vitest entry
// (unlike the bare package, whose types are a non-module global script) is
// dynamic-import-friendly and registers the matchers on vitest's expect.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')

  // Testing Library's async utilities (`findBy*`, its `waitFor`) default to a
  // 1000ms budget. That is a *polling* budget, not a statement about how long
  // the work should take, and the gate runs one worker per core: measured
  // across the full suite, per-test wall-clock stretches ~3x at p99 and ~6x at
  // p99.9 versus the same test alone. A component render that takes 600ms
  // solo — an ordinary dialog with a month grid in it — therefore blows a
  // 1000ms budget for reasons that have nothing to do with the assertion,
  // producing "Unable to find role=..." on entirely healthy code, in a
  // different file each run.
  //
  // 3000ms restores the headroom while staying well under vitest's 5000ms
  // testTimeout, which is the ordering that matters: an async util must expire
  // BEFORE the test does, so a genuine failure reports as the informative
  // "Unable to find ..." (with the DOM dump) rather than an opaque test
  // timeout. Any test whose own timeout is raised above 5000ms keeps that
  // property too. Note this governs only Testing Library's utilities —
  // `vi.waitFor` has its own separate 1000ms default and takes an explicit
  // budget per call site.
  const {configure} = await import('@testing-library/dom')
  configure({asyncUtilTimeout: 3000})
}

// L2 data-integrity invariant assertions run in every test (they hard-throw on a
// derived-data contract violation — see docs/data-integrity-defense.html L2).
setDevAssertionsEnabled(true)

// Per-test Repo lifetime (issue #813). A Repo built during a test keeps a
// parked seed-materialization pass subscribed to the SHARED db after that test
// ends, and a later test's `workspace_members` INSERT wakes it to write into a
// database `resetTestDb` has since emptied. Releasing here rather than at 246
// call sites is what makes it structural; `testRepoScope` documents why a
// `beforeAll`-built Repo is deliberately left alone. Both hooks are no-ops for
// the ~500 files that never build one.
beforeEach(beginTestRepoScope)
afterEach(endTestRepoScope)

// Add any global test setup here
