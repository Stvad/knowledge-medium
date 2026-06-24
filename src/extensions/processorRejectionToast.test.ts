import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { RejectionToastContribution } from '@/extensions/core.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { aliasPlugin } from '@/plugins/alias'
import { AliasCollisionToast } from '@/plugins/alias/AliasCollisionToast.tsx'
import { routeProcessorRejection, surfaceProcessorRejection } from './processorRejectionToast.ts'

vi.mock('@/utils/toast.js', () => ({
  // showCustom invokes its render callback with a toast id so the test
  // can assert the contribution's `render` ran with the dispatched id.
  showCustom: vi.fn((render: (id: string | number) => unknown) => render('toast-id')),
  showError: vi.fn(),
}))
const { showCustom, showError } = await import('@/utils/toast.js')

const repo = {} as Repo

describe('routeProcessorRejection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the toast contributed for the rejection code', () => {
    const render = vi.fn(() => createElement('span'))
    const contributions = new Map<string, RejectionToastContribution>([
      ['alias.collision', {code: 'alias.collision', render}],
    ])
    const error = new ProcessorRejection('msg', 'alias.collision', {alias: 'x'})

    routeProcessorRejection(error, repo, contributions)

    expect(showCustom).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledWith(error, repo, 'toast-id')
    expect(showError).not.toHaveBeenCalled()
  })

  it('falls back to the raw message when no contribution claims the code', () => {
    const error = new ProcessorRejection('something failed', 'unknown.code')

    routeProcessorRejection(error, repo, new Map())

    expect(showError).toHaveBeenCalledWith('something failed')
    expect(showCustom).not.toHaveBeenCalled()
  })
})

// Pins the contract the simplified wiring rests on: the alias plugin's
// `rejectionToastFacet` contribution survives runtime resolution (incl. its
// systemToggle boundary) and is found, by code, when read off the runtime —
// the thing `surfaceProcessorRejection` reads from `repo.facetRuntime`.
describe('surfaceProcessorRejection (resolved-runtime wiring)', () => {
  beforeEach(() => vi.clearAllMocks())

  const aliasMeta = {
    alias: 'Inbox',
    conflictingBlockId: 'blk-1',
    conflictingBlockTitle: 'Inbox',
    workspaceId: 'ws-1',
    attemptedOn: 'blk-2',
  }

  it('routes to the alias contribution resolved into the runtime', () => {
    const runtime = resolveAppRuntimeSync([aliasPlugin], {overrides: new Map()})
    const repoStub = {facetRuntime: runtime} as unknown as Repo

    surfaceProcessorRejection(
      new ProcessorRejection('raw', 'alias.collision', aliasMeta),
      repoStub,
    )

    expect(showCustom).toHaveBeenCalledOnce()
    // The showCustom mock returns its render callback's output (the element).
    expect(vi.mocked(showCustom).mock.results[0]!.value).toMatchObject({type: AliasCollisionToast})
    expect(showError).not.toHaveBeenCalled()
  })

  it('falls back to the raw message in the bootstrap window (no app facets installed)', () => {
    // Empty runtime models repo.facetRuntime during bootstrap (data-only).
    const runtime = resolveAppRuntimeSync([], {overrides: new Map()})
    const repoStub = {facetRuntime: runtime} as unknown as Repo

    surfaceProcessorRejection(
      new ProcessorRejection('bootstrap collision', 'alias.collision'),
      repoStub,
    )

    expect(showError).toHaveBeenCalledWith('bootstrap collision')
    expect(showCustom).not.toHaveBeenCalled()
  })
})
