// @vitest-environment happy-dom
//
// The review session's on-screen key hints. They are derived rather than
// written down, so the thing worth pinning is that a mid-session remap or
// unbind reaches them — a hint that keeps advertising a key the user took
// away is the bug this replaced.
import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet.js'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
  type KeybindingOverride,
} from '@/shortcuts/keybindingOverrides.js'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import {
  SRS_GRADE_ACTION_IDS,
  SRS_REVEAL_ACTION_ID,
  SRS_REVIEW_CONTEXT,
  srsReviewActionContext,
  srsReviewActions,
} from '../actions.ts'
import { useActionKeyHints } from '../keyHints.ts'

const AGAIN_ACTION_ID = SRS_GRADE_ACTION_IDS.get(SrsSignal.AGAIN)!

const buildRuntime = (): FacetRuntime => resolveFacetRuntimeSync([
  actionContextsFacet.of(srsReviewActionContext),
  srsReviewActions.map(action => actionsFacet.of(action, {source: 'test'})),
])

const renderHints = (runtime: FacetRuntime) =>
  renderHook(() => useActionKeyHints(SRS_REVIEW_CONTEXT), {
    wrapper: ({children}) => (
      <AppRuntimeContextProvider value={runtime}>{children}</AppRuntimeContextProvider>
    ),
  })

/** Push overrides the way the keybindings-settings plugin does: in place,
 *  which leaves `runtime` identity untouched. That is precisely what a
 *  `useMemo` keyed on the runtime alone would miss. */
const pushOverrides = (runtime: FacetRuntime, overrides: readonly KeybindingOverride[]) => {
  act(() => {
    runtime.setRuntimeContributions(
      keybindingOverridesFacet,
      KEYBINDING_OVERRIDE_USER_SOURCE,
      overrides,
    )
  })
}

describe('useActionKeyHints', () => {
  it('renders the default chords', () => {
    const {result} = renderHints(buildRuntime())

    // Reveal binds Space and Enter; the hint takes the first chord only.
    expect(result.current.get(SRS_REVEAL_ACTION_ID)).toBe('Space')
    expect(result.current.get(AGAIN_ACTION_ID)).toBe('1')
  })

  it('follows a remap without a remount', () => {
    const runtime = buildRuntime()
    const {result} = renderHints(runtime)
    expect(result.current.get(SRS_REVEAL_ACTION_ID)).toBe('Space')

    pushOverrides(runtime, [{
      actionId: SRS_REVEAL_ACTION_ID,
      context: SRS_REVIEW_CONTEXT,
      binding: {keys: 'KeyR'},
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
    }])

    expect(result.current.get(SRS_REVEAL_ACTION_ID)).toBe('R')
  })

  it('drops the hint for an unbound action', () => {
    const runtime = buildRuntime()
    const {result} = renderHints(runtime)
    expect(result.current.get(AGAIN_ACTION_ID)).toBe('1')

    pushOverrides(runtime, [{
      actionId: AGAIN_ACTION_ID,
      context: SRS_REVIEW_CONTEXT,
      binding: {unbound: true},
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
    }])

    expect(result.current.has(AGAIN_ACTION_ID)).toBe(false)
    // The neighbours are untouched — an unbind isn't a wipe.
    expect(result.current.get(SRS_GRADE_ACTION_IDS.get(SrsSignal.HARD)!)).toBe('2')
  })
})
