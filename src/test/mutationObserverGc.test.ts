// @vitest-environment happy-dom

/**
 * happy-dom 20.11.0 held a MutationObserver's per-target callback in a
 * `WeakRef` whose only referent was an inline closure, so the first GC after
 * the observing job collected it: `Node[reportMutation]` then spliced the
 * listener out and that observer never fired again. Every DOM test whose
 * subject uses a MutationObserver was a coin flip, and the failure reads as a
 * timeout on a stale value rather than as a dead observer — it cost two wrong
 * diagnoses before the cause was found (PR #635).
 *
 * A strongly-held callback cannot be collected, so this test is deterministic
 * in the passing direction: it can only redden if the hazard comes back via
 * the `^20.x` range. `--expose-gc` is wired in `vitest.config.ts`.
 */
import { expect, it, vi } from 'vitest'

it('keeps delivering mutation records after a GC', async () => {
  const gc = (globalThis as {gc?: () => void}).gc
  expect(gc, 'no globalThis.gc — is --expose-gc still in vitest.config.ts execArgv?')
    .toBeTypeOf('function')

  const target = document.createElement('div')
  document.body.appendChild(target)
  let fired = 0
  const observer = new MutationObserver(() => { fired++ })
  observer.observe(target, {childList: true, subtree: true})

  try {
    // The closure only becomes collectable once the job that created it has
    // ended, so yield before collecting — a same-job gc() does not reproduce.
    await new Promise(resolve => setImmediate(resolve))
    gc!()
    gc!()

    target.appendChild(document.createElement('span'))
    await vi.waitFor(() => { expect(fired).toBe(1) })
  } finally {
    observer.disconnect()
    target.remove()
  }
})
