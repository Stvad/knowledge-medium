import { describe, expect, it, vi } from 'vitest'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
} from '@/shortcuts/keybindingOverrides.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { keybindingOverridesProp } from '../config.ts'
import {
  pushOverridesToRuntime,
  readOverridesFromBlock,
} from '../effect.ts'

describe('readOverridesFromBlock', () => {
  it('returns the property value when the codec succeeds', () => {
    const block = {
      peekProperty: vi.fn().mockReturnValue([
        {actionId: 'demo', context: 'normal-mode', binding: {keys: 'cmd+k'}},
      ]),
    }
    const out = readOverridesFromBlock(block as never)
    expect(block.peekProperty).toHaveBeenCalledWith(keybindingOverridesProp)
    expect(out).toEqual([
      {actionId: 'demo', context: 'normal-mode', binding: {keys: 'cmd+k'}},
    ])
  })

  it('returns [] when the codec throws (malformed snapshot)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const block = {
      peekProperty: vi.fn().mockImplementation(() => {
        throw new Error('boom')
      }),
    }
    expect(readOverridesFromBlock(block as never)).toEqual([])
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('returns [] when the property is unset', () => {
    const block = {peekProperty: vi.fn().mockReturnValue(undefined)}
    expect(readOverridesFromBlock(block as never)).toEqual([])
  })
})

describe('pushOverridesToRuntime', () => {
  it('publishes the stored overrides to the facet at the user-prefs source', () => {
    const runtime = resolveFacetRuntimeSync([])
    pushOverridesToRuntime(runtime, [
      {actionId: 'demo', context: 'normal-mode', binding: {keys: 'cmd+k'}},
    ])
    const contributions = runtime.read(keybindingOverridesFacet)
    expect(contributions).toEqual([{
      actionId: 'demo',
      context: 'normal-mode',
      binding: {keys: 'cmd+k'},
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
    }])
  })

  it('replaces the previous bucket on each push (no accumulation)', () => {
    const runtime = resolveFacetRuntimeSync([])
    pushOverridesToRuntime(runtime, [
      {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+a'}},
    ])
    pushOverridesToRuntime(runtime, [
      {actionId: 'b', context: 'normal-mode', binding: {keys: 'cmd+b'}},
    ])
    expect(runtime.read(keybindingOverridesFacet).map(o => o.actionId))
      .toEqual(['b'])
  })

  it('clears the bucket when given an empty array', () => {
    const runtime = resolveFacetRuntimeSync([])
    pushOverridesToRuntime(runtime, [
      {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+a'}},
    ])
    pushOverridesToRuntime(runtime, [])
    expect(runtime.read(keybindingOverridesFacet)).toEqual([])
  })

  it('fires the facet change listener on each push', () => {
    const runtime = resolveFacetRuntimeSync([])
    const listener = vi.fn()
    const unsubscribe = runtime.onFacetChange(keybindingOverridesFacet.id, listener)

    pushOverridesToRuntime(runtime, [
      {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+a'}},
    ])
    pushOverridesToRuntime(runtime, [])

    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
