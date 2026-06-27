// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import { dispatchPointerAction } from '@/shortcuts/pointerAction.js'
import {
  dispatchGesture,
  beginGestureProgress,
  GESTURE_PROGRESS_CANCEL_EVENT,
} from '@/shortcuts/gestureAction.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import {
  ActiveContextsProvider,
  useActiveContextsState,
  useActiveContextsDispatch,
} from '@/shortcuts/ActiveContexts.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { actionContextsFacet, actionTransformsFacet, actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

const TEST_CONTEXT = 'test-mode' as ActionContextType
const GLOBAL_CONTEXT = 'global' as ActionContextType
const MODAL_CONTEXT = 'modal-mode' as ActionContextType
const SECOND_MODAL_CONTEXT = 'second-modal-mode' as ActionContextType

const testContextConfig: ActionContextConfig = {
  type: TEST_CONTEXT,
  displayName: 'Test Mode',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const globalContextConfig: ActionContextConfig = {
  type: GLOBAL_CONTEXT,
  displayName: 'Global',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const modalContextConfig: ActionContextConfig = {
  type: MODAL_CONTEXT,
  displayName: 'Modal Mode',
  modal: true,
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const secondModalContextConfig: ActionContextConfig = {
  type: SECOND_MODAL_CONTEXT,
  displayName: 'Second Modal Mode',
  modal: true,
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const BLOCK_POINTER_CONTEXT = 'block-pointer' as ActionContextType
const blockPointerContextConfig: ActionContextConfig = {
  type: BLOCK_POINTER_CONTEXT,
  displayName: 'Block Pointer',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const FILTERED_POINTER_CONTEXT = 'filtered-pointer' as ActionContextType
const filteredPointerContextConfig: ActionContextConfig = {
  type: FILTERED_POINTER_CONTEXT,
  displayName: 'Filtered Pointer',
  // Reject events whose target is an anchor — stands in for block-pointer's
  // "exclude interactive descendants" pointerTargetFilter.
  pointerTargetFilter: event => (event.target as HTMLElement | null)?.tagName !== 'A',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

const pointerEvent = (
  overrides: Partial<{
    type: string; button: number; detail: number
    shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean
    target: EventTarget
  }> = {},
): ReactMouseEvent<HTMLElement> => ({
  type: 'click',
  button: 0,
  detail: 1,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
}) as unknown as ReactMouseEvent<HTMLElement>

// A touch gesture is discriminated from a mouse event by `changedTouches`; the
// surface has already recognised the tap by the time it dispatches.
const touchEvent = (
  overrides: Partial<{target: EventTarget}> = {},
): ReactTouchEvent<HTMLElement> => ({
  type: 'touchend',
  changedTouches: [{clientX: 1, clientY: 1}],
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
}) as unknown as ReactTouchEvent<HTMLElement>

const HIGH_CONTEXT = 'high-priority-mode' as ActionContextType
const highContextConfig: ActionContextConfig = {
  type: HIGH_CONTEXT,
  displayName: 'High Priority Mode',
  priority: 'high',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

// Mirrors EDIT_MODE_CM: a context whose default is "don't preventDefault".
// Used to test that a binding's eventOptions override the context default
// (the precedence merge the Shift+Arrow regression got wrong).
const NO_PREVENT_DEFAULT_CONTEXT = 'no-prevent-default-mode' as ActionContextType
const noPreventDefaultContextConfig: ActionContextConfig = {
  type: NO_PREVENT_DEFAULT_CONTEXT,
  displayName: 'No-preventDefault Mode',
  defaultEventOptions: {preventDefault: false},
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
}

interface MockDeps extends BaseShortcutDependencies {
  marker: string
}

const mockDeps: MockDeps = {
  marker: 'test',
} as MockDeps

const buildAction = (overrides: Partial<ActionConfig> & Pick<ActionConfig, 'id' | 'handler' | 'defaultBinding'>): ActionConfig => ({
  description: 'test action',
  context: TEST_CONTEXT,
  ...overrides,
} as ActionConfig)

const codeFor = (key: string) => {
  if (key === 'Shift') return 'ShiftLeft'
  if (key === 'Control') return 'ControlLeft'
  if (key === 'Alt') return 'AltLeft'
  if (key === 'Meta') return 'MetaLeft'
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key
}

const dispatchKey = (type: 'keydown' | 'keyup', key: string): KeyboardEvent => {
  // tinykeys matches via event.key / event.code. Synthesise both so
  // single-letter chords ('k') match event.key and code-form chords
  // ('KeyK') match event.code. Bare modifier names ('Shift') get the
  // matching code-form ('ShiftLeft') for keyup tests where event.key
  // is the modifier itself.
  const init: KeyboardEventInit = {key, code: codeFor(key), bubbles: true, cancelable: true}
  // Returned so callers can read event.defaultPrevented after dispatch (the
  // event-options tests assert on it); existing callers ignore the return.
  const event = new KeyboardEvent(type, init)
  window.dispatchEvent(event)
  return event
}

const dispatchKeydown = (key: string) => dispatchKey('keydown', key)
const dispatchKeyup = (key: string) => dispatchKey('keyup', key)

const Activator = ({context}: {context: ActionContextType}) => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    dispatch.activate(context, mockDeps)
    return () => dispatch.deactivate(context)
  }, [dispatch, context])
  return null
}

const SequentialActivator = ({contexts}: {contexts: readonly ActionContextType[]}) => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    for (const context of contexts) dispatch.activate(context, mockDeps)
    return () => {
      for (const context of contexts) dispatch.deactivate(context)
    }
  }, [dispatch, contexts])
  return null
}

const LayoutKeydownWhenActive = ({
  context,
  keyName,
}: {
  context: ActionContextType
  keyName: string
}) => {
  const active = useActiveContextsState()
  const dispatchedRef = useRef(false)

  useLayoutEffect(() => {
    if (dispatchedRef.current) return
    if (!active.has(context)) return
    dispatchedRef.current = true
    dispatchKeydown(keyName)
  }, [active, context, keyName])

  return null
}

const Harness = ({
  actions,
  transforms = [],
  contexts,
  children,
}: {
  actions: readonly ActionConfig[]
  transforms?: Parameters<typeof actionTransformsFacet.of>[0][]
  contexts: readonly ActionContextConfig[]
  children?: ReactNode
}) => {
  const runtime = resolveFacetRuntimeSync([
    ...contexts.map(c => actionContextsFacet.of(c)),
    ...actions.map(a => actionsFacet.of(a)),
    ...transforms.map(t => actionTransformsFacet.of(t)),
  ])

  return (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        {children}
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
}

describe('HotkeyReconciler', () => {
  afterEach(() => {
    cleanup()
  })

  it('fires the handler for a single-character key when the context is active', () => {
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.k',
      handler,
      defaultBinding: {keys: 'k'},
    })

    render(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <Activator context={TEST_CONTEXT}/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      mockDeps,
      expect.any(KeyboardEvent),
      expect.objectContaining({
        activate: expect.any(Function),
        deactivate: expect.any(Function),
      }),
    )
  })

  it('fires the decorated action handler for installed hotkeys', () => {
    const calls: string[] = []
    const action = buildAction({
      id: 'test.decorated',
      handler: () => {
        calls.push('base')
      },
      defaultBinding: {keys: 'k'},
    })

    render(
      <Harness
        actions={[action]}
        transforms={[{
          actionId: action.id,
          context: TEST_CONTEXT,
          apply: current => ({
            ...current,
            handler: (deps, trigger) => {
              calls.push('decorated')
              return current.handler(deps as never, trigger)
            },
          }),
        }]}
        contexts={[testContextConfig]}
      >
        <Activator context={TEST_CONTEXT}/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(calls).toEqual(['decorated', 'base'])
  })

  it.each(['h', 'i', 'k', 'o'])(
    'fires for single letter key %s (regression: half of vim normal-mode bindings went silent)',
    (key) => {
      const handler = vi.fn()
      const action = buildAction({
        id: `test.${key}`,
        handler,
        defaultBinding: {keys: key},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      act(() => dispatchKeydown(key))
      expect(handler).toHaveBeenCalledTimes(1)
    },
  )

  it('fires only the matching key in an array binding', () => {
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.array',
      handler,
      defaultBinding: {keys: ['ArrowDown', 'k']},
    })

    render(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <Activator context={TEST_CONTEXT}/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not fire a handler whose context is inactive', () => {
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.dormant',
      handler,
      defaultBinding: {keys: 'k'},
    })

    render(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        {/* deliberately no Activator */}
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('starts firing once a context is activated mid-session', () => {
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.late',
      handler,
      defaultBinding: {keys: 'k'},
    })

    const harness = render(
      <Harness actions={[action]} contexts={[testContextConfig]}/>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler).not.toHaveBeenCalled()

    harness.rerender(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <Activator context={TEST_CONTEXT}/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  describe('modal contexts', () => {
    it('does not change install behaviour when no modal is active', () => {
      const baseHandler = vi.fn()
      const globalHandler = vi.fn()
      const baseAction = buildAction({
        id: 'test.base',
        handler: baseHandler,
        defaultBinding: {keys: 'p'},
      })
      const globalAction = buildAction({
        id: 'test.global',
        context: GLOBAL_CONTEXT,
        handler: globalHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[baseAction, globalAction]}
          contexts={[testContextConfig, globalContextConfig]}
        >
          <SequentialActivator contexts={[GLOBAL_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('p'))
      expect(baseHandler).toHaveBeenCalledTimes(1)

      act(() => dispatchKeydown('k'))
      expect(globalHandler).toHaveBeenCalledTimes(1)
    })

    it('shadows every non-global context while a modal is active', () => {
      const baseHandler = vi.fn()
      const modalHandler = vi.fn()
      const globalHandler = vi.fn()
      const baseAction = buildAction({
        id: 'test.base',
        context: TEST_CONTEXT,
        handler: baseHandler,
        defaultBinding: {keys: 'p'},
      })
      const modalAction = buildAction({
        id: 'test.modal',
        context: MODAL_CONTEXT,
        handler: modalHandler,
        defaultBinding: {keys: 'm'},
      })
      const globalAction = buildAction({
        id: 'test.global',
        context: GLOBAL_CONTEXT,
        handler: globalHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[baseAction, modalAction, globalAction]}
          contexts={[testContextConfig, modalContextConfig, globalContextConfig]}
        >
          <SequentialActivator contexts={[GLOBAL_CONTEXT, TEST_CONTEXT, MODAL_CONTEXT]}/>
        </Harness>,
      )

      // Modal's own binding fires.
      act(() => dispatchKeydown('m'))
      expect(modalHandler).toHaveBeenCalledTimes(1)

      // Global binding still fires — global carve-out keeps Cmd+K alive.
      act(() => dispatchKeydown('k'))
      expect(globalHandler).toHaveBeenCalledTimes(1)

      // Underlying (non-global, non-modal) context's binding is shadowed.
      act(() => dispatchKeydown('p'))
      expect(baseHandler).not.toHaveBeenCalled()
    })

    it('restores underlying bindings after the modal context deactivates', () => {
      const baseHandler = vi.fn()
      const baseAction = buildAction({
        id: 'test.base',
        context: TEST_CONTEXT,
        handler: baseHandler,
        defaultBinding: {keys: 'p'},
      })
      const modalAction = buildAction({
        id: 'test.modal',
        context: MODAL_CONTEXT,
        handler: vi.fn(),
        defaultBinding: {keys: 'm'},
      })

      const harness = render(
        <Harness
          actions={[baseAction, modalAction]}
          contexts={[testContextConfig, modalContextConfig]}
        >
          <SequentialActivator contexts={[TEST_CONTEXT, MODAL_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('p'))
      expect(baseHandler).not.toHaveBeenCalled()

      // Remove the modal activation; underlying TEST_CONTEXT stays.
      harness.rerender(
        <Harness
          actions={[baseAction, modalAction]}
          contexts={[testContextConfig, modalContextConfig]}
        >
          <SequentialActivator contexts={[TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('p'))
      expect(baseHandler).toHaveBeenCalledTimes(1)
    })

    it('most-recently-activated modal wins when two modals are active', () => {
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      const firstAction = buildAction({
        id: 'test.first-modal',
        context: MODAL_CONTEXT,
        handler: firstHandler,
        defaultBinding: {keys: 'm'},
      })
      const secondAction = buildAction({
        id: 'test.second-modal',
        context: SECOND_MODAL_CONTEXT,
        handler: secondHandler,
        defaultBinding: {keys: 'n'},
      })

      render(
        <Harness
          actions={[firstAction, secondAction]}
          contexts={[modalContextConfig, secondModalContextConfig]}
        >
          <SequentialActivator contexts={[MODAL_CONTEXT, SECOND_MODAL_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('n'))
      expect(secondHandler).toHaveBeenCalledTimes(1)

      act(() => dispatchKeydown('m'))
      expect(firstHandler).not.toHaveBeenCalled()
    })
  })

  describe('single winner (no double-fire)', () => {
    it('fires only the highest-precedence action when two contexts share a chord', () => {
      // Both global and the base context bind 'k' and are active. The old
      // per-action-listener model fired BOTH (the double-fire bug); the
      // coordinator must dispatch exactly one — global, as the reserved top
      // tier.
      const globalHandler = vi.fn()
      const baseHandler = vi.fn()
      const globalAction = buildAction({
        id: 'test.global-k',
        context: GLOBAL_CONTEXT,
        handler: globalHandler,
        defaultBinding: {keys: 'k'},
      })
      const baseAction = buildAction({
        id: 'test.base-k',
        context: TEST_CONTEXT,
        handler: baseHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[globalAction, baseAction]}
          contexts={[testContextConfig, globalContextConfig]}
        >
          <SequentialActivator contexts={[GLOBAL_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(globalHandler).toHaveBeenCalledTimes(1)
      expect(baseHandler).not.toHaveBeenCalled()
    })

    it('a higher-priority context wins a shared chord even when activated earlier', () => {
      // The early/late inversion: the high-priority context is activated
      // FIRST (older) and the default context LATER (newer). Recency alone
      // would pick the newer one; priority must override it.
      const highHandler = vi.fn()
      const lowHandler = vi.fn()
      const highAction = buildAction({
        id: 'test.high-k',
        context: HIGH_CONTEXT,
        handler: highHandler,
        defaultBinding: {keys: 'k'},
      })
      const lowAction = buildAction({
        id: 'test.low-k',
        context: TEST_CONTEXT,
        handler: lowHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[highAction, lowAction]}
          contexts={[highContextConfig, testContextConfig]}
        >
          <SequentialActivator contexts={[HIGH_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(highHandler).toHaveBeenCalledTimes(1)
      expect(lowHandler).not.toHaveBeenCalled()
    })

    it('falls through to the next candidate when the winner returns false', () => {
      // Option D: a handler declares "not mine" by returning a synchronous
      // `false`. The high-priority context would win 'k', but its handler
      // declines, so the coordinator falls through to the lower context.
      const declinedHandler = vi.fn(() => false as const)
      const fallbackHandler = vi.fn()
      const highAction = buildAction({
        id: 'test.high-return-false',
        context: HIGH_CONTEXT,
        handler: declinedHandler,
        defaultBinding: {keys: 'k'},
      })
      const lowAction = buildAction({
        id: 'test.low-return-fallback',
        context: TEST_CONTEXT,
        handler: fallbackHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[highAction, lowAction]}
          contexts={[highContextConfig, testContextConfig]}
        >
          <SequentialActivator contexts={[HIGH_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(declinedHandler).toHaveBeenCalledTimes(1)
      expect(fallbackHandler).toHaveBeenCalledTimes(1)
    })

    it('treats a void return as handled — the next candidate does not run', () => {
      const winnerHandler = vi.fn(() => undefined)
      const fallbackHandler = vi.fn()
      const highAction = buildAction({
        id: 'test.high-void',
        context: HIGH_CONTEXT,
        handler: winnerHandler,
        defaultBinding: {keys: 'k'},
      })
      const lowAction = buildAction({
        id: 'test.low-void-fallback',
        context: TEST_CONTEXT,
        handler: fallbackHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[highAction, lowAction]}
          contexts={[highContextConfig, testContextConfig]}
        >
          <SequentialActivator contexts={[HIGH_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(winnerHandler).toHaveBeenCalledTimes(1)
      expect(fallbackHandler).not.toHaveBeenCalled()
    })

    it('does not fall through for a Promise that resolves to false (sync sentinel only)', () => {
      // The loop chooses the next candidate within the same synchronous event
      // and cannot await — so a Promise counts as handled the moment it
      // returns, even if it later resolves to false. Only a synchronous false
      // falls through. This pins that contract.
      const asyncDeclineHandler = vi.fn(
        // Returns Promise<false> at runtime; typed loosely since the public
        // handler signature forbids it (Promise<false> ⊄ Promise<void>).
        (() => Promise.resolve(false)) as unknown as () => void,
      )
      const fallbackHandler = vi.fn()
      const highAction = buildAction({
        id: 'test.high-async-false',
        context: HIGH_CONTEXT,
        handler: asyncDeclineHandler,
        defaultBinding: {keys: 'k'},
      })
      const lowAction = buildAction({
        id: 'test.low-async-fallback',
        context: TEST_CONTEXT,
        handler: fallbackHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[highAction, lowAction]}
          contexts={[highContextConfig, testContextConfig]}
        >
          <SequentialActivator contexts={[HIGH_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(asyncDeclineHandler).toHaveBeenCalledTimes(1)
      expect(fallbackHandler).not.toHaveBeenCalled()
    })

    it('skips a candidate whose canDispatch declines and dispatches the next', () => {
      // The high-priority context would win 'k', but its canDispatch returns
      // false, so the coordinator falls through to the lower context's 'k'.
      const declinedHandler = vi.fn()
      const fallbackHandler = vi.fn()
      const highAction = buildAction({
        id: 'test.high-decline',
        context: HIGH_CONTEXT,
        handler: declinedHandler,
        canDispatch: () => false,
        defaultBinding: {keys: 'k'},
      })
      const lowAction = buildAction({
        id: 'test.low-fallback',
        context: TEST_CONTEXT,
        handler: fallbackHandler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness
          actions={[highAction, lowAction]}
          contexts={[highContextConfig, testContextConfig]}
        >
          <SequentialActivator contexts={[HIGH_CONTEXT, TEST_CONTEXT]}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(declinedHandler).not.toHaveBeenCalled()
      expect(fallbackHandler).toHaveBeenCalledTimes(1)
    })
  })

  // The event-option application seam: a matched binding's eventOptions decide
  // whether the keydown's native default is suppressed. Precedence is
  // built-in default (preventDefault: true) -> context defaultEventOptions ->
  // binding eventOptions. The Shift+Arrow text-selection regression lived
  // exactly here: an EDIT_MODE_CM binding inherited preventDefault: true and
  // swallowed CodeMirror's native shift-selection. These pin the contract
  // end-to-end via event.defaultPrevented (only the binding-config value is
  // unit-tested elsewhere).
  describe('event options (preventDefault)', () => {
    it('suppresses the native default when the binding asks for preventDefault: true', () => {
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.prevent-true',
        handler,
        defaultBinding: {keys: 'k', eventOptions: {preventDefault: true}},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(true)
    })

    it('leaves the native default intact when the binding asks for preventDefault: false', () => {
      // The regression class: the handler runs, but the native key action
      // (e.g. CodeMirror shift-selection) must survive.
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.prevent-false',
        handler,
        defaultBinding: {keys: 'k', eventOptions: {preventDefault: false}},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
    })

    it('preventDefaults by default when a binding sets no eventOptions', () => {
      // Documents the dangerous default that bit the regression: a binding
      // with no eventOptions suppresses the native default.
      const action = buildAction({
        id: 'test.prevent-default-default',
        handler: vi.fn(),
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(event.defaultPrevented).toBe(true)
    })

    it('lets the context defaultEventOptions set the default (no preventDefault)', () => {
      // Mirrors EDIT_MODE_CM: context default is preventDefault: false, and a
      // binding without its own eventOptions inherits it.
      const action = buildAction({
        id: 'test.ctx-default',
        context: NO_PREVENT_DEFAULT_CONTEXT,
        handler: vi.fn(),
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness actions={[action]} contexts={[noPreventDefaultContextConfig]}>
          <Activator context={NO_PREVENT_DEFAULT_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(event.defaultPrevented).toBe(false)
    })

    it('lets a binding override the context defaultEventOptions (this is the regression mechanism)', () => {
      // Exactly the shape of the bug: the context says "don't preventDefault",
      // but the binding's eventOptions win and re-enable it. In the real bug
      // EDIT_MODE_CM (default false) inherited a binding with preventDefault:
      // true, so the native default was wrongly suppressed.
      const action = buildAction({
        id: 'test.binding-overrides-ctx',
        context: NO_PREVENT_DEFAULT_CONTEXT,
        handler: vi.fn(),
        defaultBinding: {keys: 'k', eventOptions: {preventDefault: true}},
      })

      render(
        <Harness actions={[action]} contexts={[noPreventDefaultContextConfig]}>
          <Activator context={NO_PREVENT_DEFAULT_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(event.defaultPrevented).toBe(true)
    })

    it('does not preventDefault when the matched handler declines (sync false)', () => {
      // A declined candidate must not apply its event options: the coordinator
      // only applies them for the handler it actually dispatches. Even with
      // preventDefault: true on the binding, a decline leaves the default
      // intact (and here no other candidate handles the key).
      const declinedHandler = vi.fn(() => false as const)
      const action = buildAction({
        id: 'test.declined-no-prevent',
        handler: declinedHandler,
        defaultBinding: {keys: 'k', eventOptions: {preventDefault: true}},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      let event!: KeyboardEvent
      act(() => { event = dispatchKeydown('k') })
      expect(declinedHandler).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
    })
  })

  describe('pointer dispatch', () => {
    const pointerAction = (
      overrides: Partial<ActionConfig> & Pick<ActionConfig, 'id' | 'handler'>,
    ): ActionConfig => ({
      description: 'test pointer action',
      context: BLOCK_POINTER_CONTEXT,
      pointerBinding: {kind: 'mouse', mods: ['Shift'], phase: 'click'},
      ...overrides,
    } as ActionConfig)

    it('dispatches a matching shift-click to a pointer-bound action with supplied deps', () => {
      const handler = vi.fn()
      const action = pointerAction({id: 'pointer.shift', handler})

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      const supplied = {marker: 'clicked'} as unknown as BaseShortcutDependencies
      let handled = false
      act(() => {
        handled = dispatchPointerAction(pointerEvent({shiftKey: true}), supplied as never)
      })

      // The context is NOT active — the click supplies the deps, which reach
      // the handler unchanged.
      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toBe(supplied)
    })

    it('does not dispatch when the modifier set differs (ctrl+shift is not shift)', () => {
      const handler = vi.fn()
      const action = pointerAction({id: 'pointer.shift-only', handler})

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      let handled = true
      act(() => {
        handled = dispatchPointerAction(
          pointerEvent({shiftKey: true, ctrlKey: true}),
          {marker: 'x'} as never,
        )
      })

      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not dispatch when the context pointerTargetFilter rejects the target', () => {
      const handler = vi.fn()
      const action = {
        id: 'pointer.filtered',
        description: 'filtered pointer action',
        context: FILTERED_POINTER_CONTEXT,
        pointerBinding: {kind: 'mouse', mods: ['Shift'], phase: 'click'},
        handler,
      } as ActionConfig

      render(<Harness actions={[action]} contexts={[filteredPointerContextConfig]}/>)

      // Target is an anchor → the context filter rejects it → no candidate.
      let handled = true
      act(() => {
        handled = dispatchPointerAction(
          pointerEvent({shiftKey: true, target: document.createElement('a')}),
          {marker: 'x'} as never,
        )
      })
      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()

      // A non-anchor target passes the filter.
      act(() => {
        dispatchPointerAction(
          pointerEvent({shiftKey: true, target: document.createElement('span')}),
          {marker: 'x'} as never,
        )
      })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('matches when any of several pointer bindings matches (ctrl-OR-meta style)', () => {
      const handler = vi.fn()
      const action = {
        id: 'pointer.multi',
        description: 'multi-binding pointer action',
        context: BLOCK_POINTER_CONTEXT,
        pointerBinding: [
          {kind: 'mouse', mods: ['Shift'], phase: 'click'},
          {kind: 'mouse', mods: ['Alt'], phase: 'click'},
        ],
        handler,
      } as ActionConfig

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      act(() => { dispatchPointerAction(pointerEvent({shiftKey: true}), {marker: 'x'} as never) })
      act(() => { dispatchPointerAction(pointerEvent({altKey: true}), {marker: 'x'} as never) })
      expect(handler).toHaveBeenCalledTimes(2)

      // A plain click matches neither binding.
      let handled = true
      act(() => { handled = dispatchPointerAction(pointerEvent({}), {marker: 'x'} as never) })
      expect(handled).toBe(false)
      expect(handler).toHaveBeenCalledTimes(2)
    })

    it('falls through to the next pointer candidate when the first declines', () => {
      const declined = vi.fn(() => false as const)
      const fallback = vi.fn()
      const first = pointerAction({id: 'pointer.declines', handler: declined})
      const second = pointerAction({id: 'pointer.fallback', handler: fallback})

      render(<Harness actions={[first, second]} contexts={[blockPointerContextConfig]}/>)

      act(() => {
        dispatchPointerAction(pointerEvent({shiftKey: true}), {marker: 'x'} as never)
      })

      expect(declined).toHaveBeenCalledTimes(1)
      expect(fallback).toHaveBeenCalledTimes(1)
    })

    it('dispatches a double-click (pointerdown, detail 2) but not a single click', () => {
      const handler = vi.fn()
      const action = pointerAction({
        id: 'pointer.double',
        handler,
        pointerBinding: {kind: 'mouse', detail: 2, phase: 'pointerdown'},
      })

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      // A single mousedown (detail 1) at the same phase doesn't match.
      let handled = true
      act(() => {
        handled = dispatchPointerAction(
          pointerEvent({type: 'mousedown', detail: 1}),
          {marker: 'x'} as never,
        )
      })
      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()

      act(() => {
        handled = dispatchPointerAction(
          pointerEvent({type: 'mousedown', detail: 2}),
          {marker: 'x'} as never,
        )
      })
      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('dispatches a touch tap to a touch-bound action', () => {
      const handler = vi.fn()
      const supplied = {marker: 'tapped'} as unknown as BaseShortcutDependencies
      const action = pointerAction({
        id: 'pointer.tap',
        handler,
        pointerBinding: {kind: 'touch', phase: 'tap'},
      })

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      let handled = false
      act(() => { handled = dispatchPointerAction(touchEvent(), supplied as never) })

      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toBe(supplied)
    })

    it('does not cross-match a mouse gesture to a touch binding (or vice versa)', () => {
      const tapHandler = vi.fn()
      const clickHandler = vi.fn()
      const tapAction = pointerAction({
        id: 'pointer.tap-only',
        handler: tapHandler,
        pointerBinding: {kind: 'touch', phase: 'tap'},
      })
      const clickAction = pointerAction({
        id: 'pointer.click-only',
        handler: clickHandler,
        pointerBinding: {kind: 'mouse', mods: [], phase: 'click'},
      })

      render(<Harness actions={[tapAction, clickAction]} contexts={[blockPointerContextConfig]}/>)

      // A plain click reaches the mouse action, not the touch one.
      act(() => { dispatchPointerAction(pointerEvent({}), {marker: 'x'} as never) })
      expect(clickHandler).toHaveBeenCalledTimes(1)
      expect(tapHandler).not.toHaveBeenCalled()

      // A tap reaches the touch action, not the mouse one.
      act(() => { dispatchPointerAction(touchEvent(), {marker: 'x'} as never) })
      expect(tapHandler).toHaveBeenCalledTimes(1)
      expect(clickHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('gesture dispatch', () => {
    // The commit event a recognizer hands the dispatcher — any ActionTrigger;
    // a CustomEvent stands in here. Spied so we can assert the dispatch ate it
    // (suppressing the trailing synthesized click).
    const gestureTrigger = (): import('@/shortcuts/types.js').ActionTrigger => ({
      type: 'gesture-commit',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as never

    const gestureAction = (
      overrides: Partial<ActionConfig> & Pick<ActionConfig, 'id' | 'handler'>,
    ): ActionConfig => ({
      description: 'test gesture action',
      context: BLOCK_POINTER_CONTEXT,
      gestureBinding: {gesture: 'swipe-right'},
      ...overrides,
    } as ActionConfig)

    it('dispatches a matching gesture to a gesture-bound action with supplied deps', () => {
      const handler = vi.fn()
      const action = gestureAction({id: 'gesture.swipe-right', handler})

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      // The context is NOT active — the gesture supplies the deps, which reach
      // the handler unchanged.
      const supplied = {marker: 'swiped'} as unknown as BaseShortcutDependencies
      const trigger = gestureTrigger()
      let handled = false
      act(() => { handled = dispatchGesture('swipe-right', supplied, trigger) })

      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toBe(supplied)
      // Default event options ate the commit event.
      expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    })

    it('does not dispatch when the emitted gesture name differs from the binding', () => {
      const handler = vi.fn()
      render(
        <Harness actions={[gestureAction({id: 'g', handler})]} contexts={[blockPointerContextConfig]}/>,
      )

      let handled = true
      act(() => { handled = dispatchGesture('swipe-left', {marker: 'x'} as never, gestureTrigger()) })

      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    })

    it('matches when any of several gesture bindings names the gesture', () => {
      const handler = vi.fn()
      const action = gestureAction({
        id: 'g.multi',
        handler,
        gestureBinding: [{gesture: 'swipe-left'}, {gesture: 'swipe-right'}],
      })

      render(<Harness actions={[action]} contexts={[blockPointerContextConfig]}/>)

      act(() => { dispatchGesture('swipe-left', {marker: 'x'} as never, gestureTrigger()) })
      act(() => { dispatchGesture('swipe-right', {marker: 'x'} as never, gestureTrigger()) })
      expect(handler).toHaveBeenCalledTimes(2)

      // A gesture neither binding names matches nothing.
      let handled = true
      act(() => { handled = dispatchGesture('two-finger-scrub', {marker: 'x'} as never, gestureTrigger()) })
      expect(handled).toBe(false)
      expect(handler).toHaveBeenCalledTimes(2)
    })

    it('falls through to the next gesture candidate when the first declines', () => {
      const declined = vi.fn(() => false as const)
      const fallback = vi.fn()
      const first = gestureAction({id: 'g.declines', handler: declined})
      const second = gestureAction({id: 'g.fallback', handler: fallback})

      render(<Harness actions={[first, second]} contexts={[blockPointerContextConfig]}/>)

      act(() => { dispatchGesture('swipe-right', {marker: 'x'} as never, gestureTrigger()) })

      expect(declined).toHaveBeenCalledTimes(1)
      expect(fallback).toHaveBeenCalledTimes(1)
    })
  })

  describe('gesture progress dispatch', () => {
    // The progress dispatcher (the single-winner preview channel) has only ever
    // been exercised through the controller's mock; these drive the real
    // `beginGestureProgress` the reconciler installs. Swipe-left is its only
    // production caller today, so the contract lives here.
    const progressTick = (): import('@/shortcuts/types.js').ActionTrigger =>
      new CustomEvent('date-scrub-tick', {detail: {deltaDays: 1}})

    const progressAction = (
      overrides: Partial<ActionConfig> & Pick<ActionConfig, 'id' | 'handler'>,
    ): ActionConfig => ({
      description: 'test progress action',
      context: BLOCK_POINTER_CONTEXT,
      gestureBinding: {gesture: 'date-scrub', phase: 'progress'},
      ...overrides,
    } as ActionConfig)

    it('streams every tick and the terminal settle to one resolved winner', () => {
      const handler = vi.fn()
      render(<Harness actions={[progressAction({id: 'p.scrub', handler})]} contexts={[blockPointerContextConfig]}/>)

      // The context is NOT active — the gesture supplies the deps, which reach
      // every tick unchanged (resolved once, not re-resolved per tick).
      const supplied = {marker: 'scrubbing'} as unknown as BaseShortcutDependencies
      let dispatch: ReturnType<typeof beginGestureProgress> = null
      act(() => { dispatch = beginGestureProgress('date-scrub', supplied) })
      expect(dispatch).not.toBeNull()

      act(() => { dispatch!.update(progressTick()) })
      act(() => { dispatch!.update(progressTick()) })
      act(() => { dispatch!.settle() })

      expect(handler).toHaveBeenCalledTimes(3)
      expect(handler.mock.calls.every(call => call[0] === supplied)).toBe(true)
      // Active ticks carry the recognizer's own event; the settle arrives as the
      // synthesized cancel event so a progress action can tell them apart.
      expect((handler.mock.calls[0]?.[1] as CustomEvent).type).toBe('date-scrub-tick')
      expect((handler.mock.calls[2]?.[1] as CustomEvent).type).toBe(GESTURE_PROGRESS_CANCEL_EVENT)
    })

    it('returns null when only a commit binding names the gesture', () => {
      const handler = vi.fn()
      // Defaults to the commit phase, so no progress binding matches.
      const commitOnly = progressAction({id: 'p.commit', handler, gestureBinding: {gesture: 'date-scrub'}})
      render(<Harness actions={[commitOnly]} contexts={[blockPointerContextConfig]}/>)

      let dispatch: ReturnType<typeof beginGestureProgress> = {} as never
      act(() => { dispatch = beginGestureProgress('date-scrub', {marker: 'x'} as never) })

      expect(dispatch).toBeNull()
      expect(handler).not.toHaveBeenCalled()
    })

    it('binds a single winner — a second matching action never receives ticks', () => {
      const winner = vi.fn()
      const other = vi.fn()
      render(
        <Harness
          actions={[
            progressAction({id: 'p.winner', handler: winner}),
            progressAction({id: 'p.other', handler: other}),
          ]}
          contexts={[blockPointerContextConfig]}
        />,
      )

      let dispatch: ReturnType<typeof beginGestureProgress> = null
      act(() => { dispatch = beginGestureProgress('date-scrub', {marker: 'x'} as never) })
      act(() => { dispatch!.update(progressTick()) })

      expect(winner).toHaveBeenCalledTimes(1)
      expect(other).not.toHaveBeenCalled()
    })

    it('skips a candidate whose canDispatch declines and binds the next', () => {
      const declinedHandler = vi.fn()
      const fallback = vi.fn()
      const declines = progressAction({
        id: 'p.declines',
        handler: declinedHandler,
        canDispatch: () => false,
      })
      const second = progressAction({id: 'p.fallback', handler: fallback})
      render(<Harness actions={[declines, second]} contexts={[blockPointerContextConfig]}/>)

      let dispatch: ReturnType<typeof beginGestureProgress> = null
      act(() => { dispatch = beginGestureProgress('date-scrub', {marker: 'x'} as never) })
      act(() => { dispatch!.update(progressTick()) })

      expect(declinedHandler).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledTimes(1)
    })

    it('contains a throwing progress handler instead of letting it escape the tick', () => {
      const handler = vi.fn(() => { throw new Error('bad tick') })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      render(<Harness actions={[progressAction({id: 'p.throws', handler})]} contexts={[blockPointerContextConfig]}/>)

      let dispatch: ReturnType<typeof beginGestureProgress> = null
      act(() => { dispatch = beginGestureProgress('date-scrub', {marker: 'x'} as never) })

      expect(() => act(() => { dispatch!.update(progressTick()) })).not.toThrow()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })
  })

  describe('supplied-deps action dispatch', () => {
    const byIdAction = (
      overrides: Partial<ActionConfig> & Pick<ActionConfig, 'id' | 'handler'>,
    ): ActionConfig => ({
      description: 'test supplied action',
      context: TEST_CONTEXT,
      ...overrides,
    } as ActionConfig)

    it('runs an action by id with supplied deps when its context is not active', () => {
      const handler = vi.fn()
      const action = byIdAction({id: 'block.swipe-right', handler})

      // TEST_CONTEXT is never activated (no Activator) — the deps are supplied.
      render(<Harness actions={[action]} contexts={[testContextConfig]}/>)

      const supplied = {marker: 'swiped'} as unknown as BaseShortcutDependencies
      let handled = false
      act(() => {
        handled = dispatchActionWithDeps('block.swipe-right', supplied, new CustomEvent('swipe'))
      })

      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toBe(supplied)
    })

    it('returns false when no action matches the id', () => {
      render(<Harness actions={[]} contexts={[testContextConfig]}/>)

      let handled = true
      act(() => {
        handled = dispatchActionWithDeps('nope', {marker: 'x'} as never, new CustomEvent('swipe'))
      })

      expect(handled).toBe(false)
    })

    it('falls through (not handled) when canDispatch declines', () => {
      const handler = vi.fn()
      const action = byIdAction({id: 'gated', handler, canDispatch: () => false})

      render(<Harness actions={[action]} contexts={[testContextConfig]}/>)

      let handled = true
      act(() => {
        handled = dispatchActionWithDeps('gated', {marker: 'x'} as never, new CustomEvent('swipe'))
      })

      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  it('observes the latest dependencies after the context re-activates with new ones', () => {
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.refresh',
      handler,
      defaultBinding: {keys: 'k'},
    })

    const FreshDeps = ({marker}: {marker: string}) => {
      const dispatch = useActiveContextsDispatch()
      useEffect(() => {
        dispatch.activate(TEST_CONTEXT, {marker} as MockDeps)
        return () => dispatch.deactivate(TEST_CONTEXT)
      }, [dispatch, marker])
      return null
    }

    const harness = render(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <FreshDeps marker="first"/>
      </Harness>,
    )
    act(() => dispatchKeydown('k'))
    expect(handler.mock.calls[0]?.[0]).toMatchObject({marker: 'first'})

    harness.rerender(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <FreshDeps marker="second"/>
      </Harness>,
    )
    act(() => dispatchKeydown('k'))
    expect(handler.mock.calls[1]?.[0]).toMatchObject({marker: 'second'})
  })

  describe('dispatch arg', () => {
    it('passes a dispatch object with activate/deactivate to the handler', () => {
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.dispatch-shape',
        handler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      const dispatchArg = handler.mock.calls[0]?.[2]
      expect(dispatchArg).toEqual(expect.objectContaining({
        activate: expect.any(Function),
        deactivate: expect.any(Function),
      }))
    })

    it('activate() from a handler makes another context fire', () => {
      const secondaryHandler = vi.fn()
      const enterAction = buildAction({
        id: 'test.enter-secondary',
        handler: (_deps, _trigger, dispatch) => {
          dispatch?.activate(SECOND_MODAL_CONTEXT, mockDeps)
        },
        defaultBinding: {keys: 'g'},
      })
      const secondaryAction = buildAction({
        id: 'test.secondary',
        context: SECOND_MODAL_CONTEXT,
        handler: secondaryHandler,
        defaultBinding: {keys: 's'},
      })

      render(
        <Harness
          actions={[enterAction, secondaryAction]}
          contexts={[testContextConfig, secondModalContextConfig]}
        >
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      // Secondary context not active yet — its binding doesn't fire.
      act(() => dispatchKeydown('s'))
      expect(secondaryHandler).not.toHaveBeenCalled()

      // Entering activates the secondary context.
      act(() => dispatchKeydown('g'))

      // Now the secondary binding fires.
      act(() => dispatchKeydown('s'))
      expect(secondaryHandler).toHaveBeenCalledTimes(1)
    })

    it('deactivate() from a handler removes the context', () => {
      const exitHandler = vi.fn((_deps, _trigger, dispatch?) => {
        dispatch?.deactivate(SECOND_MODAL_CONTEXT)
      })
      const stillThereHandler = vi.fn()
      const exitAction = buildAction({
        id: 'test.exit-secondary',
        context: SECOND_MODAL_CONTEXT,
        handler: exitHandler,
        defaultBinding: {keys: 'x'},
      })
      const stillThereAction = buildAction({
        id: 'test.still-there',
        context: SECOND_MODAL_CONTEXT,
        handler: stillThereHandler,
        defaultBinding: {keys: 's'},
      })

      render(
        <Harness
          actions={[exitAction, stillThereAction]}
          contexts={[secondModalContextConfig]}
        >
          <Activator context={SECOND_MODAL_CONTEXT}/>
        </Harness>,
      )

      // Both bindings live in the modal context — fires before exit.
      act(() => dispatchKeydown('s'))
      expect(stillThereHandler).toHaveBeenCalledTimes(1)

      // Exit deactivates the context.
      act(() => dispatchKeydown('x'))
      expect(exitHandler).toHaveBeenCalledTimes(1)

      // After deactivation the modal's bindings no longer fire.
      act(() => dispatchKeydown('s'))
      expect(stillThereHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('phase', () => {
    it('does not fire a keyup binding on keydown', () => {
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.shift-release',
        handler,
        defaultBinding: {keys: 'Shift', phase: 'keyup'},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      act(() => dispatchKeydown('Shift'))
      expect(handler).not.toHaveBeenCalled()
    })

    it('fires a keyup binding on key release', () => {
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.shift-release',
        handler,
        defaultBinding: {keys: 'Shift', phase: 'keyup'},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      act(() => dispatchKeyup('Shift'))
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('still fires on keydown when phase is unset (default behaviour)', () => {
      const handler = vi.fn()
      const action = buildAction({
        id: 'test.default-phase',
        handler,
        defaultBinding: {keys: 'k'},
      })

      render(
        <Harness actions={[action]} contexts={[testContextConfig]}>
          <Activator context={TEST_CONTEXT}/>
        </Harness>,
      )

      act(() => dispatchKeydown('k'))
      expect(handler).toHaveBeenCalledTimes(1)

      act(() => dispatchKeyup('k'))
      expect(handler).toHaveBeenCalledTimes(1)
    })

    describe('hold', () => {
      it('does not fire when the key is released before the threshold', () => {
        vi.useFakeTimers()
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-short',
            handler,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 200},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(100))
          act(() => dispatchKeyup('s'))
          act(() => vi.advanceTimersByTime(500))

          expect(handler).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })

      it('fires once the threshold elapses with the key still held', () => {
        vi.useFakeTimers()
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-fires',
            handler,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 200},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(199))
          expect(handler).not.toHaveBeenCalled()

          act(() => vi.advanceTimersByTime(1))
          expect(handler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('does not fire when canDispatch declines, even after the threshold', () => {
        // Hold dispatch must honour the same canDispatch gate the keydown/keyup
        // coordinator enforces — otherwise hold bindings are the one path that
        // fires in a state the action opted out of.
        vi.useFakeTimers()
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-candispatch',
            handler,
            canDispatch: () => false,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 200},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(300))
          expect(handler).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })

      it('ignores OS-repeat keydowns while held', () => {
        vi.useFakeTimers()
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-repeat',
            handler,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 200},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          // Several OS-repeat keydowns of the same key — should not
          // re-arm or fire twice.
          for (let i = 0; i < 5; i++) {
            act(() => {
              window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 's', code: codeFor('s'), repeat: true, bubbles: true, cancelable: true,
              }))
            })
          }
          act(() => vi.advanceTimersByTime(200))
          expect(handler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('releasing the key after the timer fires does not re-fire', () => {
        vi.useFakeTimers()
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-release-after',
            handler,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 100},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(100))
          expect(handler).toHaveBeenCalledTimes(1)

          act(() => dispatchKeyup('s'))
          expect(handler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('hold handler can activate another context, whose bindings then fire', () => {
        vi.useFakeTimers()
        try {
          const secondaryHandler = vi.fn()
          const enterAction = buildAction({
            id: 'test.hold-enter',
            handler: (_deps, _trigger, dispatch) => {
              dispatch?.activate(SECOND_MODAL_CONTEXT, mockDeps)
            },
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 100},
          })
          const secondaryAction = buildAction({
            id: 'test.hold-secondary',
            context: SECOND_MODAL_CONTEXT,
            handler: secondaryHandler,
            defaultBinding: {keys: 'j'},
          })

          render(
            <Harness
              actions={[enterAction, secondaryAction]}
              contexts={[testContextConfig, secondModalContextConfig]}
            >
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          // Secondary context not yet active.
          act(() => dispatchKeydown('j'))
          expect(secondaryHandler).not.toHaveBeenCalled()

          // Hold s for 100ms → enter action fires → activates secondary.
          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(100))

          // Secondary context's binding now fires.
          act(() => dispatchKeydown('j'))
          expect(secondaryHandler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('hold-fired modal context shadows an underlying context binding on the next keydown', () => {
        vi.useFakeTimers()
        try {
          const baseHandler = vi.fn()
          const modalHandler = vi.fn()
          const enterAction = buildAction({
            id: 'test.hold-shadow-enter',
            handler: (_deps, _trigger, dispatch) => {
              dispatch?.activate(MODAL_CONTEXT, mockDeps)
            },
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 100},
          })
          // Same key 'h' bound in both contexts. With modal shadowing
          // the underlying TEST_CONTEXT binding should NOT fire while
          // MODAL_CONTEXT is active.
          const baseAction = buildAction({
            id: 'test.base-h',
            context: TEST_CONTEXT,
            handler: baseHandler,
            defaultBinding: {keys: 'h'},
          })
          const modalAction = buildAction({
            id: 'test.modal-h',
            context: MODAL_CONTEXT,
            handler: modalHandler,
            defaultBinding: {keys: 'h'},
          })

          render(
            <Harness
              actions={[enterAction, baseAction, modalAction]}
              contexts={[testContextConfig, modalContextConfig]}
            >
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(100))

          act(() => dispatchKeydown('h'))
          expect(baseHandler).not.toHaveBeenCalled()
          expect(modalHandler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('ignores stale underlying listeners during modal activation before passive reconciliation', () => {
        vi.useFakeTimers()
        try {
          const baseHandler = vi.fn()
          const modalHandler = vi.fn()
          const enterAction = buildAction({
            id: 'test.hold-shadow-stale-enter',
            handler: (_deps, _trigger, dispatch) => {
              dispatch?.activate(MODAL_CONTEXT, mockDeps)
            },
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 100},
          })
          const baseAction = buildAction({
            id: 'test.stale-base-h',
            context: TEST_CONTEXT,
            handler: baseHandler,
            defaultBinding: {keys: 'h'},
          })
          const modalAction = buildAction({
            id: 'test.stale-modal-h',
            context: MODAL_CONTEXT,
            handler: modalHandler,
            defaultBinding: {keys: 'h'},
          })

          render(
            <Harness
              actions={[enterAction, baseAction, modalAction]}
              contexts={[testContextConfig, modalContextConfig]}
            >
              <Activator context={TEST_CONTEXT}/>
              <LayoutKeydownWhenActive context={MODAL_CONTEXT} keyName="h"/>
            </Harness>,
          )

          act(() => dispatchKeydown('s'))
          act(() => vi.advanceTimersByTime(100))

          expect(baseHandler).not.toHaveBeenCalled()

          modalHandler.mockClear()
          act(() => dispatchKeydown('h'))
          expect(baseHandler).not.toHaveBeenCalled()
          expect(modalHandler).toHaveBeenCalledTimes(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('hold-fired modal shadowing works with real timers and no extra act wrapping around the keydown', async () => {
        const baseHandler = vi.fn()
        const modalHandler = vi.fn()
        const enterAction = buildAction({
          id: 'test.hold-real-enter',
          handler: (_deps, _trigger, dispatch) => {
            dispatch?.activate(MODAL_CONTEXT, mockDeps)
          },
          defaultBinding: {keys: 's', phase: 'hold', holdMs: 20},
        })
        const baseAction = buildAction({
          id: 'test.real-base-h',
          context: TEST_CONTEXT,
          handler: baseHandler,
          defaultBinding: {keys: 'h'},
        })
        const modalAction = buildAction({
          id: 'test.real-modal-h',
          context: MODAL_CONTEXT,
          handler: modalHandler,
          defaultBinding: {keys: 'h'},
        })

        render(
          <Harness
            actions={[enterAction, baseAction, modalAction]}
            contexts={[testContextConfig, modalContextConfig]}
          >
            <Activator context={TEST_CONTEXT}/>
          </Harness>,
        )

        // Real-time hold: dispatch s, wait past holdMs, then dispatch h
        // WITHOUT wrapping the h in another act(). Mirrors the browser
        // path where the user's next keypress arrives between React's
        // commit and useEffect flushing.
        dispatchKeydown('s')
        await new Promise(r => setTimeout(r, 80))
        dispatchKeydown('h')
        // Allow any pending React work to settle, then assert.
        await new Promise(r => setTimeout(r, 50))

        expect(baseHandler).not.toHaveBeenCalled()
        expect(modalHandler).toHaveBeenCalledTimes(1)
      })

      it('skips sequence-chord hold bindings (warned at install)', () => {
        vi.useFakeTimers()
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-sequence',
            handler,
            defaultBinding: {keys: 'g g', phase: 'hold', holdMs: 100},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          act(() => dispatchKeydown('g'))
          act(() => vi.advanceTimersByTime(200))
          act(() => dispatchKeydown('g'))
          act(() => vi.advanceTimersByTime(200))

          expect(handler).not.toHaveBeenCalled()
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('sequence chord'),
          )
        } finally {
          warnSpy.mockRestore()
          vi.useRealTimers()
        }
      })

      it('does not arm when the keydown is filtered out (typing in editable)', () => {
        vi.useFakeTimers()
        const input = document.createElement('input')
        document.body.appendChild(input)
        input.focus()
        // Guard against a silent false-green: if focus didn't take, the
        // "filtered out" path wouldn't be exercised and the test would
        // pass for the wrong reason.
        expect(document.activeElement).toBe(input)
        try {
          const handler = vi.fn()
          const action = buildAction({
            id: 'test.hold-filtered',
            handler,
            defaultBinding: {keys: 's', phase: 'hold', holdMs: 100},
          })

          render(
            <Harness actions={[action]} contexts={[testContextConfig]}>
              <Activator context={TEST_CONTEXT}/>
            </Harness>,
          )

          // Dispatch a keydown whose target is the focused <input>.
          act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: 's', code: codeFor('s'), bubbles: true, cancelable: true,
            }))
          })
          act(() => vi.advanceTimersByTime(200))

          expect(handler).not.toHaveBeenCalled()
        } finally {
          input.remove()
          vi.useRealTimers()
        }
      })
    })
  })
})
