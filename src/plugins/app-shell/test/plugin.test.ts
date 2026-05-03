import { describe, expect, it } from 'vitest'
import { appMountsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { appShellPlugin } from '../index.ts'

describe('appShellPlugin', () => {
  it('contributes command palette and quick find root mounts', () => {
    const runtime = resolveFacetRuntimeSync(appShellPlugin)
    const mounts = runtime.read(appMountsFacet)

    expect(mounts.map(mount => mount.id)).toEqual([
      'app-shell.command-palette',
      'app-shell.quick-find',
    ])
  })
})
