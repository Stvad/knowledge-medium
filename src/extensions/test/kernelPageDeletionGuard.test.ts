// @vitest-environment node
import {describe, expect, it} from 'vitest'
import type {Block} from '@/data/block'
import {systemPagesFacet} from '@/data/facets'
import {kernelPageBlockId, type KernelPageSpec} from '@/data/kernelPage'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {kernelPageDeletionGuard} from '../kernelPageDeletionGuard'

const spec: KernelPageSpec = {
  namespace: '22222222-2222-4222-8222-222222222222', alias: 'Test container', markerType: null,
}
const workspaceId = 'workspace'
const block = (id: string, registered: boolean, ws = workspaceId): Block => ({
  id,
  peek: () => ({workspaceId: ws}),
  repo: {facetRuntime: resolveFacetRuntimeSync(registered
    ? [systemPagesFacet.of({spec, eager: false})] : [])},
} as unknown as Block)

describe('kernelPageDeletionGuard', () => {
  it('allows an unloaded block', () => {
    expect(kernelPageDeletionGuard({peek: () => null} as unknown as Block)).toBeNull()
  })
  it('refuses a registered id without querying, regardless of alias or types', () => {
    expect(kernelPageDeletionGuard(block(kernelPageBlockId(workspaceId, spec.namespace), true)))
      .toContain(spec.alias)
  })
  it('allows an unregistered kernel page when its owner is absent', () => {
    expect(kernelPageDeletionGuard(block(kernelPageBlockId(workspaceId, spec.namespace), false))).toBeNull()
  })
  it('allows an ordinary block even with an owner installed', () => {
    expect(kernelPageDeletionGuard(block('ordinary', true))).toBeNull()
  })
  it('does not match a block in another workspace against this workspace’s id', () => {
    expect(kernelPageDeletionGuard(block(kernelPageBlockId(workspaceId, spec.namespace), true, 'other'))).toBeNull()
  })
})
