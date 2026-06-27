// @vitest-environment jsdom
/**
 * Safe-mode behaviour at the resolver level.
 *
 * `?safeMode` in the URL is the recovery escape hatch — when set, it
 * should disable every non-essential system plugin even if the
 * overrides map says otherwise. Essentials stay on (otherwise the app
 * couldn't recover: kernel data, action-context validation, renderer
 * fallback, etc).
 *
 * Tests guard the policy at the smallest unit (the resolver) so the
 * recovery path is verifiable independent of AppRuntimeProvider's
 * wiring.
 */
import {describe, expect, it} from 'vitest'
import {
  actionContextsFacet,
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
} from '@/extensions/core.js'
import {defineFacet} from '@/facets/facet.js'
import {resolveAppRuntimeSync, resolveAppRuntime} from '@/facets/resolveAppRuntime.js'
import {staticAppExtensions} from '@/extensions/staticAppExtensions.js'
import {systemToggle, type Overrides} from '@/facets/togglable.js'
import {COMMAND_PALETTE_ACTION_ID} from '@/plugins/command-palette'
import {RELOAD_IN_SAFE_MODE_ACTION_ID} from '@/shortcuts/defaultShortcuts.js'
import {ActionContextTypes} from '@/shortcuts/types.js'
import type {Repo} from '@/data/repo.js'

const empty: Overrides = new Map()

describe('resolveAppRuntime — safeMode', () => {
  it('excludes non-essential boundaries in safe mode regardless of overrides', () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.non-essential',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:opt', name: 'Optional'})

    // No override for it → default enabled, but safe mode trumps.
    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('would-be-on')])],
      {overrides: empty, safeMode: true},
    )

    expect(runtime.read(labels)).toBe('')
  })

  it('keeps essential boundaries in safe mode', () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.essential',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({
      id: 'system:core',
      name: 'Core',
      essential: true,
    })

    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('still-on')])],
      {overrides: empty, safeMode: true},
    )

    expect(runtime.read(labels)).toBe('still-on')
  })

  it('ignores an explicit `true` override on non-essentials in safe mode', () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.override-true',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({
      id: 'system:experimental',
      name: 'Experimental',
      defaultEnabled: false,
    })

    // User has explicitly enabled an opt-in plugin. Safe mode still
    // skips it — recovery, not user preference, is the goal.
    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('explicit-but-skipped')])],
      {overrides: new Map([['system:experimental', true]]), safeMode: true},
    )

    expect(runtime.read(labels)).toBe('')
  })

  it('behaves identically to isEnabled when safe mode is off', () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.off',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:normal', name: 'Normal'})

    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('normal-on')])],
      {overrides: empty, safeMode: false},
    )

    expect(runtime.read(labels)).toBe('normal-on')
  })

  it('omitting safeMode is equivalent to safeMode: false', () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.omitted',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:omit', name: 'Omit'})

    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('default-on')])],
      {overrides: empty},
    )

    expect(runtime.read(labels)).toBe('default-on')
  })

  it('applies the same policy on the async resolver', async () => {
    const labels = defineFacet<string, string>({
      id: 'safe-mode.async',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:async-opt', name: 'AsyncOpt'})
    const essential = systemToggle({
      id: 'system:async-core',
      name: 'AsyncCore',
      essential: true,
    })

    const runtime = await resolveAppRuntime(
      [
        handle.of([labels.of('non-essential')]),
        essential.of([labels.of('essential')]),
      ],
      {overrides: empty, safeMode: true},
    )

    expect(runtime.read(labels)).toBe('essential')
  })

  it('keeps action context registration available in safe mode', () => {
    const runtime = resolveAppRuntimeSync(
      staticAppExtensions({repo: {} as Repo}),
      {overrides: empty, safeMode: true},
    )

    expect(runtime.read(actionContextsFacet).map(context => context.type)).toContain(
      ActionContextTypes.GLOBAL,
    )
    expect(runtime.read(actionsFacet).some(action => action.id === RELOAD_IN_SAFE_MODE_ACTION_ID)).toBe(false)
  })

  it('keeps header and command palette recovery UI available in safe mode', () => {
    const runtime = resolveAppRuntimeSync(
      staticAppExtensions({repo: {} as Repo}),
      {overrides: empty, safeMode: true},
    )
    const headerItemIds = runtime.read(headerItemsFacet).map(item => item.id)
    const mountIds = runtime.read(appMountsFacet).map(mount => mount.id)
    const actionIds = runtime.read(actionsFacet).map(action => action.id)

    expect(headerItemIds).toEqual(expect.arrayContaining([
      'workspace-header.pending-invitations',
      'command-palette.header',
    ]))
    expect(mountIds).toContain('command-palette.dialog')
    expect(actionIds).toContain(COMMAND_PALETTE_ACTION_ID)
  })
})
