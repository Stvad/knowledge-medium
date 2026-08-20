// @vitest-environment happy-dom

/**
 * happy-dom 20.11.0 held a MutationObserver's per-target callback in a
 * `WeakRef` whose only referent was an inline closure, so the first GC after
 * the observing job collected it: `Node[reportMutation]` spliced the listener
 * out and the observer never fired again. It presents as a DOM test timing out
 * on a stale value, not as a dead observer (PR #635). `^20.x` admits it coming
 * back; a strongly-held callback cannot be collected, so this only reddens if
 * it does.
 */
import { expect, it, vi } from 'vitest'

it('keeps delivering mutation records after a GC', async () => {
  const gc = (globalThis as {gc?: () => void}).gc
  if (!gc) throw new Error('no globalThis.gc — is --expose-gc still in vitest.config.ts execArgv?')

  const target = document.createElement('div')
  document.body.appendChild(target)
  let fired = 0
  const observer = new MutationObserver(() => { fired++ })
  observer.observe(target, {childList: true, subtree: true})

  // Control: a closure held ONLY by a WeakRef, collected the same way the
  // 20.11.0 callback was. Without it this test cannot tell "the callback
  // survived" from "nothing was collected at all", and would go green
  // forever the day the collection premise stops holding.
  const collectable = new WeakRef(() => target)

  // The closure only becomes collectable once the job that created it has
  // ended, so yield first — a same-job gc() does not reproduce. Twice because
  // one cycle leaves the WeakRef intact often enough to matter.
  await new Promise(resolve => setImmediate(resolve))
  gc()
  gc()
  expect(collectable.deref(), 'GC premise no longer holds — this test proves nothing').toBeUndefined()

  // Counted after the collection, so this asserts POST-GC delivery rather
  // than "something fired at some point".
  const firedBeforeMutation = fired
  target.appendChild(document.createElement('span'))
  await vi.waitFor(() => { expect(fired).toBeGreaterThan(firedBeforeMutation) })

  observer.disconnect()
  target.remove()
})
