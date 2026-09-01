// @vitest-environment happy-dom
import { useMemo, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { actionContextsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  ActiveContextsProvider,
  useActiveContextsState,
} from '@/shortcuts/ActiveContexts.js'
import {
  BackgroundSubtreeContext,
  BackgroundSubtreeProvider,
} from '@/context/backgroundSubtree.js'
import { useActionContext, useActionContextActivations } from '@/shortcuts/useActionContext.js'
import type {
  ActionContextConfig,
  ActionContextType,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import type { Block } from '@/data/block.js'

// `useActionContextActivations` folds the UI-state block into every
// activation's dependencies; nothing under test reads it, so a stand-in
// keeps this a pure shortcut-layer test (no repo / db harness).
const fakeUIStateBlock = {id: 'ui-state'} as unknown as Block
vi.mock('@/data/globalState.ts', () => ({
  useUIStateBlock: () => fakeUIStateBlock,
}))

const CTX_A = 'suspension-test-a' as ActionContextType
const CTX_B = 'suspension-test-b' as ActionContextType
const CONTESTED = 'suspension-test-contested' as ActionContextType

interface MarkerDeps extends BaseShortcutDependencies {
  marker: string
}

const contextConfig = (type: ActionContextType): ActionContextConfig => ({
  type,
  displayName: type,
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
})

const ALL_CONTEXTS = [CTX_A, CTX_B, CONTESTED]

/** A consumer of the declarative funnel — the shape every shortcut surface has. */
const Registrant = ({context, marker}: {context: ActionContextType; marker: string}) => {
  const activations = useMemo(
    () => [{context, dependencies: {marker}}],
    [context, marker],
  )
  useActionContextActivations(activations)
  return null
}

/** Renders which marker currently OWNS each context, or `none`. */
const Probe = () => {
  const active = useActiveContextsState()
  return (
    <>
      {ALL_CONTEXTS.map(context => (
        <div key={context} data-testid={`owner-${context}`}>
          {(active.get(context) as MarkerDeps | undefined)?.marker ?? 'none'}
        </div>
      ))}
    </>
  )
}

const Harness = ({children}: {children?: ReactNode}) => {
  const runtime = resolveFacetRuntimeSync(
    ALL_CONTEXTS.map(context => actionContextsFacet.of(contextConfig(context))),
  )
  return (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <Probe/>
        {children}
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
}

const owner = (context: ActionContextType) =>
  screen.getByTestId(`owner-${context}`).textContent

describe('shortcut-surface suspension', () => {
  afterEach(cleanup)

  it('registers normally with no suspension provider mounted', () => {
    render(
      <Harness>
        <Registrant context={CTX_A} marker="a"/>
      </Harness>,
    )

    expect(owner(CTX_A)).toBe('a')
  })

  it('deregisters a subtree while suspended and re-registers it on unsuspend', () => {
    const tree = (suspended: boolean) => (
      <Harness>
        <BackgroundSubtreeProvider background={suspended}>
          <Registrant context={CTX_A} marker="a"/>
        </BackgroundSubtreeProvider>
      </Harness>
    )

    const {rerender} = render(tree(false))
    expect(owner(CTX_A)).toBe('a')

    rerender(tree(true))
    expect(owner(CTX_A)).toBe('none')

    rerender(tree(false))
    expect(owner(CTX_A)).toBe('a')
  })

  it('suspending one subtree leaves a sibling subtree registered', () => {
    const tree = (suspended: boolean) => (
      <Harness>
        <BackgroundSubtreeProvider background={suspended}>
          <Registrant context={CTX_A} marker="a"/>
        </BackgroundSubtreeProvider>
        <BackgroundSubtreeProvider background={false}>
          <Registrant context={CTX_B} marker="b"/>
        </BackgroundSubtreeProvider>
      </Harness>
    )

    const {rerender} = render(tree(false))
    expect([owner(CTX_A), owner(CTX_B)]).toEqual(['a', 'b'])

    rerender(tree(true))
    // Both halves matter: the suspended sibling must actually go away, and
    // the live one must be untouched by its neighbour's deregistration.
    expect([owner(CTX_A), owner(CTX_B)]).toEqual(['none', 'b'])
  })

  it('keeps a nested subtree suspended even when it asks not to be', () => {
    render(
      <Harness>
        <BackgroundSubtreeProvider background={true}>
          <BackgroundSubtreeProvider background={false}>
            <Registrant context={CTX_A} marker="a"/>
          </BackgroundSubtreeProvider>
        </BackgroundSubtreeProvider>
      </Harness>,
    )

    expect(owner(CTX_A)).toBe('none')
  })

  it('lets the raw context un-suspend a descendant (documented escape hatch)', () => {
    render(
      <Harness>
        <BackgroundSubtreeProvider background={true}>
          <BackgroundSubtreeContext.Provider value={false}>
            <Registrant context={CTX_A} marker="a"/>
          </BackgroundSubtreeContext.Provider>
        </BackgroundSubtreeProvider>
      </Harness>,
    )

    expect(owner(CTX_A)).toBe('a')
  })

  // The ownership property the keep-alive host depends on: after a handover,
  // the ARRIVING subtree owns the contested context.
  //
  // Both this and the split-commit case below are pinned because they used to
  // differ. Under by-type `deactivate` only the one-commit handover worked —
  // React runs every passive-effect DESTROY before any CREATE, so the leaver's
  // blind deactivate landed first and the arriver's activate was the last
  // write. Token-keyed claim/release made that accident unnecessary; keep both
  // so a regression to by-type removal fails here rather than in a host.
  it('hands a contested context to the subtree that unsuspends in the same commit', () => {
    const tree = (leftSuspended: boolean) => (
      <Harness>
        <BackgroundSubtreeProvider background={leftSuspended}>
          <Registrant context={CONTESTED} marker="left"/>
        </BackgroundSubtreeProvider>
        <BackgroundSubtreeProvider background={!leftSuspended}>
          <Registrant context={CONTESTED} marker="right"/>
        </BackgroundSubtreeProvider>
      </Harness>
    )

    const {rerender} = render(tree(false))
    expect(owner(CONTESTED)).toBe('left')

    // One commit: left suspends, right unsuspends.
    rerender(tree(true))
    expect(owner(CONTESTED)).toBe('right')

    // And back, to show it isn't an artifact of source order.
    rerender(tree(false))
    expect(owner(CONTESTED)).toBe('left')
  })

  // KNOWN GAP, asserted as the contract we want rather than the outcome we
  // get. Split the handover above across two commits — the arriver registers
  // first, the leaver suspends after — and the leaver's blind
  // `deactivate(CONTESTED)` is the only effect that re-runs. It deletes the
  // arriver's live claim, whose own effect deps never moved, so nothing
  // re-registers and the context ends up owned by NOBODY ('none' today).
  //
  // Suspension does not cause this — `deactivate`-by-type does
  // (docs/activeContexts-ownership-bug.md) — but suspension is what makes it
  // reachable without an unmount, so it belongs pinned here. Ownership-aware
  // claims make the release scoped to the claimer and this passes; when that
  // lands, drop the `.fails`.
  it('hands a contested context over when the halves land in different commits', () => {
    const tree = (leftSuspended: boolean, rightMounted: boolean) => (
      <Harness>
        <BackgroundSubtreeProvider background={leftSuspended}>
          <Registrant context={CONTESTED} marker="left"/>
        </BackgroundSubtreeProvider>
        {rightMounted ? (
          <BackgroundSubtreeProvider background={false}>
            <Registrant context={CONTESTED} marker="right"/>
          </BackgroundSubtreeProvider>
        ) : null}
      </Harness>
    )

    const {rerender} = render(tree(false, false))
    expect(owner(CONTESTED)).toBe('left')

    // Commit 1: the arriving lane mounts unsuspended and takes ownership.
    rerender(tree(false, true))
    expect(owner(CONTESTED)).toBe('right')

    // Commit 2: the outgoing lane suspends.
    rerender(tree(true, true))
    expect(owner(CONTESTED)).toBe('right')
  })

  // The five cases above drive `useActionContextActivations` directly. The
  // surfaces that actually exist reach it through the wrappers, so pin that
  // the gate is inherited rather than re-implemented per entry point.
  it('suspends a surface registered through the public `useActionContext` wrapper', () => {
    const WrapperRegistrant = () => {
      useActionContext(CTX_B, {marker: 'wrapped'} as Record<string, unknown>)
      return null
    }
    const tree = (suspended: boolean) => (
      <Harness>
        <BackgroundSubtreeProvider background={suspended}>
          <WrapperRegistrant/>
        </BackgroundSubtreeProvider>
      </Harness>
    )

    const {rerender} = render(tree(false))
    expect(owner(CTX_B)).toBe('wrapped')

    rerender(tree(true))
    expect(owner(CTX_B)).toBe('none')
  })
})
