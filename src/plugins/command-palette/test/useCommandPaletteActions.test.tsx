// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { actionsFacet, actionContextsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts.js'
import {
  type ActionConfig,
  ActionContextTypes,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { useCommandPaletteActions } from '../useCommandPaletteActions.ts'
import {
  commandPaletteAction,
  commandPaletteForBlockAction,
} from '../index.ts'

vi.mock('@/shortcuts/ActiveContexts.tsx', () => ({
  useActiveContextsState: () => activeContextsMock,
}))

let activeContextsMock: ReadonlyMap<string, BaseShortcutDependencies>

const renderHookWithRuntime = (runtime: FacetRuntime) =>
  renderHook(() => useCommandPaletteActions(), {
    wrapper: ({children}) => (
      <AppRuntimeContextProvider value={runtime}>{children}</AppRuntimeContextProvider>
    ),
  })

describe('useCommandPaletteActions canRun filter', () => {
  it('hides actions whose canRun returns false against the active context deps', () => {
    const always: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'always',
      description: 'Always',
      context: ActionContextTypes.NORMAL_MODE,
      handler: vi.fn(),
    }
    const gated: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'gated',
      description: 'Gated',
      context: ActionContextTypes.NORMAL_MODE,
      canRun: ({block}) => block.id === 'allowed',
      handler: vi.fn(),
    }
    const runtime = resolveFacetRuntimeSync([
      defaultActionContextConfigs.map(c => actionContextsFacet.of(c)),
      actionsFacet.of(commandPaletteAction, {source: 'test'}),
      actionsFacet.of(always, {source: 'test'}),
      actionsFacet.of(gated, {source: 'test'}),
    ])

    // First pass: deps have block 'denied' — gated should be filtered out.
    activeContextsMock = new Map<string, BaseShortcutDependencies>([
      [ActionContextTypes.NORMAL_MODE, {
        block: {id: 'denied'},
        uiStateBlock: {id: 'denied'},
      } as never],
    ])
    let result = renderHookWithRuntime(runtime).result.current
    expect(result.actions.map(a => a.id).sort()).toEqual(['always'])

    // Second pass: deps have block 'allowed' — gated now visible.
    activeContextsMock = new Map<string, BaseShortcutDependencies>([
      [ActionContextTypes.NORMAL_MODE, {
        block: {id: 'allowed'},
        uiStateBlock: {id: 'allowed'},
      } as never],
    ])
    result = renderHookWithRuntime(runtime).result.current
    expect(result.actions.map(a => a.id).sort()).toEqual(['always', 'gated'])
  })

  it('hides both palette-opening actions from the palette list', () => {
    const runtime = resolveFacetRuntimeSync([
      defaultActionContextConfigs.map(c => actionContextsFacet.of(c)),
      actionsFacet.of(commandPaletteAction, {source: 'test'}),
      actionsFacet.of(commandPaletteForBlockAction, {source: 'test'}),
    ])

    activeContextsMock = new Map<string, BaseShortcutDependencies>([
      [ActionContextTypes.NORMAL_MODE, {
        block: {id: 'b'},
        uiStateBlock: {id: 'b'},
      } as never],
    ])
    const {result} = renderHookWithRuntime(runtime)
    const ids = result.current.actions.map(a => a.id)
    expect(ids).not.toContain(commandPaletteAction.id)
    expect(ids).not.toContain(commandPaletteForBlockAction.id)
  })

  it('passes through actions without a canRun predicate (default visible)', () => {
    const noPred: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'no-pred',
      description: 'No predicate',
      context: ActionContextTypes.NORMAL_MODE,
      handler: vi.fn(),
    }
    const runtime = resolveFacetRuntimeSync([
      defaultActionContextConfigs.map(c => actionContextsFacet.of(c)),
      actionsFacet.of(commandPaletteAction, {source: 'test'}),
      actionsFacet.of(noPred, {source: 'test'}),
    ])

    activeContextsMock = new Map<string, BaseShortcutDependencies>([
      [ActionContextTypes.NORMAL_MODE, {
        block: {id: 'b'},
        uiStateBlock: {id: 'b'},
      } as never],
    ])
    const {result} = renderHookWithRuntime(runtime)
    expect(result.current.actions.map(a => a.id)).toContain('no-pred')
  })
})
