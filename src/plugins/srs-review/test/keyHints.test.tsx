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
import type { ActionConfig } from '@/shortcuts/types.js'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import {
  SRS_DEFAULT_GRADE_SIGNAL,
  SRS_GRADE_ACTION_IDS,
  SRS_REVEAL_ACTION_ID,
  SRS_REVIEW_CONTEXT,
  srsReviewActionContext,
  srsReviewActions,
} from '../actions.ts'
import { gradeButtonHint, keyHintsByActionId, useActionKeyHints } from '../keyHints.ts'

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

/** Synthetic actions, so what a chord turns into is pinned without writing
 *  the SRS defaults down a second time. */
const syntheticAction = (
  id: string,
  keys: string | string[] | undefined,
  context: string = SRS_REVIEW_CONTEXT,
): ActionConfig => ({
  id,
  description: id,
  context,
  ...(keys === undefined ? {} : {defaultBinding: {keys}}),
  handler: () => {},
} as ActionConfig)

describe('keyHintsByActionId', () => {
  it('formats the first chord of a multi-chord binding', () => {
    const hints = keyHintsByActionId(
      [syntheticAction('multi', ['Space', 'Enter'])],
      SRS_REVIEW_CONTEXT,
    )

    // Not "Space ⏎": one hint sits inline on a button, and the shortcut-help
    // overlay is the surface that lists every chord.
    expect(hints.get('multi')).toBe('Space')
  })

  it('omits an action with no binding rather than mapping it to an empty hint', () => {
    const hints = keyHintsByActionId([syntheticAction('bare', undefined)], SRS_REVIEW_CONTEXT)

    expect(hints.has('bare')).toBe(false)
  })

  it('ignores actions belonging to another context', () => {
    const hints = keyHintsByActionId([syntheticAction('elsewhere', 'KeyR', 'global')], SRS_REVIEW_CONTEXT)

    expect(hints.has('elsewhere')).toBe(false)
  })
})

describe('gradeButtonHint', () => {
  const HINTS = new Map([
    [AGAIN_ACTION_ID, '1'],
    [SRS_GRADE_ACTION_IDS.get(SRS_DEFAULT_GRADE_SIGNAL)!, '3'],
    [SRS_REVEAL_ACTION_ID, 'Space'],
  ])

  it('adds the reveal chord to the default-grade button only', () => {
    // Reveal grades this signal once the answer is up, so the button
    // under-reports what triggers it if the chord is left off.
    expect(gradeButtonHint(HINTS, SRS_DEFAULT_GRADE_SIGNAL)).toBe('3 · Space')
    expect(gradeButtonHint(HINTS, SrsSignal.AGAIN)).toBe('1')
  })

  it('keeps whichever half is still bound', () => {
    const noGradeKey = new Map([[SRS_REVEAL_ACTION_ID, 'Space']])
    expect(gradeButtonHint(noGradeKey, SRS_DEFAULT_GRADE_SIGNAL)).toBe('Space')

    const noRevealKey = new Map([[SRS_GRADE_ACTION_IDS.get(SRS_DEFAULT_GRADE_SIGNAL)!, '3']])
    expect(gradeButtonHint(noRevealKey, SRS_DEFAULT_GRADE_SIGNAL)).toBe('3')
  })

  it('gives no hint when neither action is bound', () => {
    expect(gradeButtonHint(new Map(), SRS_DEFAULT_GRADE_SIGNAL)).toBeUndefined()
  })

  it('names a chord once when both actions are bound to it', () => {
    const shared = new Map([
      [SRS_GRADE_ACTION_IDS.get(SRS_DEFAULT_GRADE_SIGNAL)!, 'G'],
      [SRS_REVEAL_ACTION_ID, 'G'],
    ])

    expect(gradeButtonHint(shared, SRS_DEFAULT_GRADE_SIGNAL)).toBe('G')
  })
})

describe('useActionKeyHints', () => {
  it('follows a remap without a remount', () => {
    const runtime = buildRuntime()
    const {result} = renderHints(runtime)
    expect(result.current.has(SRS_REVEAL_ACTION_ID)).toBe(true)

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
    // The hint has to be seen present first: `has === false` passes on its
    // own against an empty map, which is what a broken hook returns.
    expect(result.current.has(AGAIN_ACTION_ID)).toBe(true)

    pushOverrides(runtime, [{
      actionId: AGAIN_ACTION_ID,
      context: SRS_REVIEW_CONTEXT,
      binding: {unbound: true},
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
    }])

    expect(result.current.has(AGAIN_ACTION_ID)).toBe(false)
    // The neighbours are untouched — an unbind isn't a wipe.
    expect(result.current.has(SRS_GRADE_ACTION_IDS.get(SrsSignal.HARD)!)).toBe(true)
  })
})
