import { describe, expect, it, afterEach, vi } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import {
  ActiveContextsProvider,
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
import { useEffect, type ReactNode } from 'react'

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
    expect(handler).toHaveBeenCalledWith(mockDeps, expect.any(KeyboardEvent))
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
  })
})
