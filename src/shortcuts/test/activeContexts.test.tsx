// @vitest-environment happy-dom
/**
 * Ownership semantics of `ActiveContextsProvider` — the cases
 * `activeContextsOwnership.fuzz.test.tsx` explores randomly, pinned as
 * examples. Everything here is about WHO owns a context type when more
 * than one caller wants it at the same time.
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Must be a STABLE object: the funnel memoizes on it
// (useActionContext.ts:35), so a fresh one per call would re-run every
// surface's effect on every render and re-claim contexts by accident.
const FAKE_UI_STATE_BLOCK = {id: 'ui-state-block'}
vi.mock('@/data/globalState.ts', () => ({
  useUIStateBlock: () => FAKE_UI_STATE_BLOCK,
}))
import {
  ActiveContextsProvider,
  useActiveContextsDispatch,
  useActiveContextsState,
  type ActiveContextsMap,
} from '@/shortcuts/ActiveContexts.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { useActionContextActivations } from '@/shortcuts/useActionContext.js'
import type {
  ActionContextConfig,
  ActionContextType,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'

const SHARED = 'shared-context' as ActionContextType
/** Two MODAL contexts: `computeInstallableContexts` collapses the installable
 *  set to {GLOBAL, most-recent-modal} using the active map's ITERATION ORDER
 *  (resolve.ts:69-78), which is the downstream reader the `seq` sort exists
 *  for. */
const MODAL_ONE = 'modal-one' as ActionContextType
const MODAL_TWO = 'modal-two' as ActionContextType

const anyDeps = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null

const contextConfig = (type: ActionContextType, modal = false): ActionContextConfig => ({
  type,
  displayName: type,
  modal,
  validateDependencies: anyDeps,
})

/** Records which modal context's action actually ran for a keypress. */
const fired: string[] = []

const runtime = resolveFacetRuntimeSync([
  actionContextsFacet.of(contextConfig(SHARED)),
  actionContextsFacet.of(contextConfig(MODAL_ONE, true)),
  actionContextsFacet.of(contextConfig(MODAL_TWO, true)),
  ...[MODAL_ONE, MODAL_TWO].map(context => actionsFacet.of({
    id: `test.${context}`,
    description: context,
    context,
    defaultBinding: {keys: 'x'},
    handler: () => { fired.push(context) },
  })),
])

const pressX = () => window.dispatchEvent(
  new KeyboardEvent('keydown', {key: 'x', code: 'KeyX', bubbles: true, cancelable: true}),
)

/** A declarative surface claiming an arbitrary context. */
function ModalSurface({owner, context}: {owner: string; context: ActionContextType}) {
  const activations = useMemo(
    () => [{context, dependencies: {owner}}],
    [owner, context],
  )
  useActionContextActivations(activations)
  return null
}

const ownerOf = (active: ActiveContextsMap) =>
  (active.get(SHARED) as {owner?: string} | undefined)?.owner

/** A declarative surface, the way every block registers one. The
 *  activations array is memoized exactly as the real resolver's is
 *  (useShortcutSurfaceActivations.ts:86) — an unstable identity would
 *  re-run the effect on every parent render and re-claim the context by
 *  accident, hiding the very thing these tests check. */
function Surface({owner}: {owner: string}) {
  const activations = useMemo(
    () => [{context: SHARED, dependencies: {owner}}],
    [owner],
  )
  useActionContextActivations(activations)
  return null
}

function Observer({sinkRef}: {sinkRef: {current: ActiveContextsMap; updates: number}}) {
  const active = useActiveContextsState()
  // `updates` counts distinct map IDENTITIES, which is exactly what costs
  // HotkeyReconciler a full re-install of every binding.
  useEffect(() => {
    sinkRef.current = active
    sinkRef.updates += 1
  }, [active, sinkRef])
  return null
}

function Imperative({owner}: {owner: string}) {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    // Two activations, one deactivation — the "re-enter a mode without
    // exiting it" shape an action handler can produce.
    dispatch.activate(SHARED, {owner: `${owner}-1`} as unknown as BaseShortcutDependencies)
    dispatch.activate(SHARED, {owner: `${owner}-2`} as unknown as BaseShortcutDependencies)
    return () => dispatch.deactivate(SHARED)
  }, [dispatch, owner])
  return null
}

/** Hands the provider's dispatch back to the test so activations can be
 *  driven one commit at a time. */
function DispatchProbe({sinkRef}: {sinkRef: {current?: ReturnType<typeof useActiveContextsDispatch>}}) {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    sinkRef.current = dispatch
  }, [dispatch, sinkRef])
  return null
}

const harness = (sinkRef: {current: ActiveContextsMap; updates: number}, children: ReactNode) => (
  <AppRuntimeContextProvider value={runtime}>
    <ActiveContextsProvider>
      <Observer sinkRef={sinkRef}/>
      {children}
    </ActiveContextsProvider>
  </AppRuntimeContextProvider>
)

/** Same, with the real keyboard dispatcher mounted. */
const keyboardHarness = (children: ReactNode) => (
  <AppRuntimeContextProvider value={runtime}>
    <ActiveContextsProvider>
      <HotkeyReconciler/>
      {children}
    </ActiveContextsProvider>
  </AppRuntimeContextProvider>
)

const newSinkRef = () => ({current: new Map() as ActiveContextsMap, updates: 0})

describe('ActiveContexts ownership', () => {
  afterEach(cleanup)

  it('keeps a sibling surface owning the context when the other one goes away', () => {
    // The reported bug: two surfaces legitimately claim one context type
    // (two panels with a multi-select, a parent + descendant video-player
    // scope, several kept-alive layout sessions). Whoever registered last
    // is visible; the OTHER tearing down must not take the context with it.
    const sinkRef = newSinkRef()
    const view = render(harness(sinkRef, <><Surface owner="a"/><Surface owner="b"/></>))
    expect(ownerOf(sinkRef.current)).toBe('b')

    act(() => {
      view.rerender(harness(sinkRef, <><Surface owner="a"/></>))
    })
    expect(sinkRef.current.has(SHARED)).toBe(true)
    expect(ownerOf(sinkRef.current)).toBe('a')
  })

  it('resurfaces the older claim when the newer one is released', () => {
    const sinkRef = newSinkRef()
    const view = render(harness(sinkRef, <><Surface owner="a"/><Surface owner="b"/></>))
    expect(ownerOf(sinkRef.current)).toBe('b')

    act(() => {
      view.rerender(harness(sinkRef, <><Surface owner="a"/><span/></>))
    })
    expect(ownerOf(sinkRef.current)).toBe('a')

    // …and the context disappears only once the LAST claim is gone.
    act(() => {
      view.rerender(harness(sinkRef, <><span/><span/></>))
    })
    expect(sinkRef.current.has(SHARED)).toBe(false)
  })

  it('treats imperative activate/deactivate as one claim per context type', () => {
    // `activate` is the "enter a mode" path (date-scrub's hold, a leader
    // chord). Re-entering must refresh the existing claim rather than stack
    // a second one, or the single `deactivate` on exit would leave a claim
    // behind that nothing can ever release.
    const sinkRef = newSinkRef()
    const view = render(harness(sinkRef, <Imperative owner="modal"/>))
    expect(ownerOf(sinkRef.current)).toBe('modal-2')

    act(() => {
      view.rerender(harness(sinkRef, <span/>))
    })
    expect(sinkRef.current.has(SHARED)).toBe(false)
  })

  it('does not let an imperative deactivate strip a declarative surface', () => {
    const sinkRef = newSinkRef()
    const view = render(harness(sinkRef, <><Surface owner="a"/><Imperative owner="modal"/></>))
    expect(ownerOf(sinkRef.current)).toBe('modal-2')

    act(() => {
      view.rerender(harness(sinkRef, <><Surface owner="a"/><span/></>))
    })
    expect(ownerOf(sinkRef.current)).toBe('a')
  })

  it('does not churn state when re-activating with unchanged dependencies', () => {
    // HotkeyReconciler re-installs every binding when the map identity
    // moves, so the redundant activation must be a genuine no-op.
    const sinkRef = newSinkRef()
    const probe: {current?: ReturnType<typeof useActiveContextsDispatch>} = {}
    const deps = {owner: 'stable'} as unknown as BaseShortcutDependencies
    render(harness(sinkRef, <DispatchProbe sinkRef={probe}/>))

    act(() => probe.current?.activate(SHARED, deps))
    const settled = sinkRef.current
    const updates = sinkRef.updates
    expect(ownerOf(settled)).toBe('stable')

    act(() => probe.current?.activate(SHARED, deps))
    expect(sinkRef.current).toBe(settled)
    expect(sinkRef.updates).toBe(updates)
  })

  it('hands the context to the incoming surface when a swap lands in ONE commit', () => {
    // "activate/deactivate during the same render cycle" — the case
    // docs/activeContexts-ownership-bug.md asks for by name. Two sibling
    // lanes trade places in a single commit: the outgoing one releases and
    // the incoming one claims with no render in between.
    const sinkRef = newSinkRef()
    const view = render(harness(sinkRef, <><Surface owner="a"/><span/></>))
    expect(ownerOf(sinkRef.current)).toBe('a')

    act(() => {
      view.rerender(harness(sinkRef, <><span/><Surface owner="b"/></>))
    })
    expect(ownerOf(sinkRef.current)).toBe('b')
    expect(sinkRef.current.size).toBe(1)
  })

  it('dispatches to the most recently claimed modal, not the first-claimed type', () => {
    // The real shortcut flow, through HotkeyReconciler — a green reconciler
    // unit test is explicitly not evidence here, so this drives an actual
    // keypress. The scenario is the one where iteration order over per-type
    // claim stacks diverges from activation recency, which is what the
    // reverted attempt (a7483fa's `computeTopMap`) got wrong:
    //
    //   1. surface a claims MODAL_ONE  → type keys [one]
    //   2. surface b claims MODAL_TWO  → type keys [one, two], recent = two
    //   3. surface c claims MODAL_ONE  → type keys STILL [one, two],
    //      but the most recent activation is one.
    //
    // Iterating the stacks map says "two"; activation recency says "one".
    fired.length = 0
    const view = render(keyboardHarness(<ModalSurface owner="a" context={MODAL_ONE}/>))

    act(() => {
      view.rerender(keyboardHarness(<>
        <ModalSurface owner="a" context={MODAL_ONE}/>
        <ModalSurface owner="b" context={MODAL_TWO}/>
      </>))
    })
    act(() => { pressX() })
    expect(fired).toEqual([MODAL_TWO])

    act(() => {
      view.rerender(keyboardHarness(<>
        <ModalSurface owner="a" context={MODAL_ONE}/>
        <ModalSurface owner="b" context={MODAL_TWO}/>
        <ModalSurface owner="c" context={MODAL_ONE}/>
      </>))
    })
    act(() => { pressX() })
    expect(fired).toEqual([MODAL_TWO, MODAL_ONE])
  })
})
