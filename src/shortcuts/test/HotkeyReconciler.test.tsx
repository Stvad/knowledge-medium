import { describe, expect, it, afterEach, vi } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import {
  ActiveContextsProvider,
  useActiveContextsState,
  useActiveContextsDispatch,
} from '@/shortcuts/ActiveContexts.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { actionContextsFacet, actionDecoratorsFacet, actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
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

const HIGH_CONTEXT = 'high-priority-mode' as ActionContextType
const highContextConfig: ActionContextConfig = {
  type: HIGH_CONTEXT,
  displayName: 'High Priority Mode',
  priority: 'high',
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

const dispatchKey = (type: 'keydown' | 'keyup', key: string) => {
  // tinykeys matches via event.key / event.code. Synthesise both so
  // single-letter chords ('k') match event.key and code-form chords
  // ('KeyK') match event.code. Bare modifier names ('Shift') get the
  // matching code-form ('ShiftLeft') for keyup tests where event.key
  // is the modifier itself.
  const init: KeyboardEventInit = {key, code: codeFor(key), bubbles: true, cancelable: true}
  window.dispatchEvent(new KeyboardEvent(type, init))
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
  decorators = [],
  contexts,
  children,
}: {
  actions: readonly ActionConfig[]
  decorators?: Parameters<typeof actionDecoratorsFacet.of>[0][]
  contexts: readonly ActionContextConfig[]
  children?: ReactNode
}) => {
  const runtime = resolveFacetRuntimeSync([
    ...contexts.map(c => actionContextsFacet.of(c)),
    ...actions.map(a => actionsFacet.of(a)),
    ...decorators.map(d => actionDecoratorsFacet.of(d)),
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
        decorators={[{
          actionId: action.id,
          context: TEST_CONTEXT,
          decorate: current => ({
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
