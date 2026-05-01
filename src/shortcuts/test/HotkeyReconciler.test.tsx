import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import hotkeys from 'hotkeys-js'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.tsx'
import {
  ActiveContextsProvider,
  useActiveContextsDispatch,
} from '@/shortcuts/ActiveContexts.tsx'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  BaseShortcutDependencies,
} from '@/shortcuts/types.ts'
import { useEffect, type ReactNode } from 'react'

const TEST_CONTEXT = 'test-mode' as ActionContextType

const testContextConfig: ActionContextConfig = {
  type: TEST_CONTEXT,
  displayName: 'Test Mode',
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

const dispatchKeydown = (key: string) => {
  // hotkeys-js installs a keydown listener on document and reads the legacy
  // `event.keyCode`/`event.which` to look up handlers. jsdom doesn't populate
  // those automatically from `key`, so we set them explicitly here.
  const code =
    key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key
  const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }),
  )
}

const Activator = ({context}: {context: ActionContextType}) => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    const handle = dispatch.activate(context, mockDeps)
    return () => dispatch.deactivate(handle)
  }, [dispatch, context])
  return null
}

const Harness = ({
  actions,
  contexts,
  children,
}: {
  actions: readonly ActionConfig[]
  contexts: readonly ActionContextConfig[]
  children?: ReactNode
}) => {
  const runtime = resolveFacetRuntimeSync([
    ...contexts.map(c => actionContextsFacet.of(c)),
    ...actions.map(a => actionsFacet.of(a)),
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
  beforeEach(() => {
    // Each test starts with a clean hotkeys-js handler table so registrations
    // from one test don't leak into another's dispatch.
    hotkeys.unbind()
  })

  afterEach(() => {
    cleanup()
    hotkeys.unbind()
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
      defaultBinding: {keys: ['down', 'k']},
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
        const handle = dispatch.activate(TEST_CONTEXT, {marker} as MockDeps)
        return () => dispatch.deactivate(handle)
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

  it('preserves the surviving claim when one of two overlapping owners unmounts', () => {
    // Regression: prior to handle-scoped deactivation, two components racing
    // to claim the same context-type clobbered each other on unmount —
    // whoever cleaned up nuked the entry regardless of who currently owned
    // it. A nested layout that mounts BlockChildren inside a parent's
    // surface is the canonical trigger.
    const handler = vi.fn()
    const action = buildAction({
      id: 'test.overlap',
      handler,
      defaultBinding: {keys: 'k'},
    })

    const Claim = ({marker}: {marker: string}) => {
      const dispatch = useActiveContextsDispatch()
      useEffect(() => {
        const handle = dispatch.activate(TEST_CONTEXT, {marker} as MockDeps)
        return () => dispatch.deactivate(handle)
      }, [dispatch, marker])
      return null
    }

    const harness = render(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <Claim marker="parent"/>
        <Claim marker="child"/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    // Most recent claim wins.
    expect(handler.mock.calls[0]?.[0]).toMatchObject({marker: 'child'})

    // Child unmounts — parent's claim must remain active.
    harness.rerender(
      <Harness actions={[action]} contexts={[testContextConfig]}>
        <Claim marker="parent"/>
      </Harness>,
    )

    act(() => dispatchKeydown('k'))
    expect(handler.mock.calls[1]?.[0]).toMatchObject({marker: 'parent'})

    // Parent unmounts — context goes silent.
    harness.rerender(
      <Harness actions={[action]} contexts={[testContextConfig]}/>,
    )

    const beforeIdleDispatch = handler.mock.calls.length
    act(() => dispatchKeydown('k'))
    expect(handler.mock.calls.length).toBe(beforeIdleDispatch)
  })
})
