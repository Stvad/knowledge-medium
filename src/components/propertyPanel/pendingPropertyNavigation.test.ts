// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {focusAdjacentPendingProperty, navigatePendingProperty} from './pendingPropertyNavigation'

vi.mock('@/extensions/blockInteraction', async importOriginal => ({
  ...await importOriginal<object>(), enterEditModeForBlock: vi.fn(),
}))

const scope = 'outline:current'
const block = vi.fn((id: string) => ({id}))
const children = vi.fn(() => {throw new Error('Navigation must not read structural children')})
const ui = {repo: {block, query: {children}}} as unknown as Block
const pending = (renderScopeId = scope) => {
  const row = document.createElement('div')
  row.dataset.pendingPropertyScopeId = renderScopeId
  row.append(document.createElement('input'))
  return row
}
const real = (id: string, renderScopeId = scope, lazy = false) => {
  const row = document.createElement('div')
  if (lazy) {
    row.dataset.lazyBlockId = id
    row.dataset.lazyRenderScopeId = renderScopeId
  } else {
    row.dataset.blockShell = 'true'
    row.dataset.blockId = id
    row.dataset.renderScopeId = renderScopeId
  }
  return row
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => {document.body.replaceChildren()})

describe('pending property drawn-row navigation', () => {
  it('declines entry when the source is absent from the drawn rows', () => {
    const target = pending()
    document.body.append(target)
    expect(focusAdjacentPendingProperty('missing', scope, 1)).toBe(false)
    expect(document.activeElement).not.toBe(target.querySelector('input'))
  })

  it('does not inspect drawn rows without a rendered scope', () => {
    const query = vi.spyOn(document, 'querySelectorAll')
    try {
      expect(focusAdjacentPendingProperty('owner', undefined, 1)).toBe(false)
      expect(query).not.toHaveBeenCalled()
    } finally {query.mockRestore()}
  })

  it('declines a pending row whose input is absent', () => {
    const target = pending()
    target.replaceChildren()
    document.body.append(real('owner'), target)
    expect(focusAdjacentPendingProperty('owner', scope, 1)).toBe(false)
  })

  it('declines a pending input that cannot receive focus', () => {
    const target = pending()
    target.querySelector('input')!.disabled = true
    document.body.append(real('owner'), target)
    expect(focusAdjacentPendingProperty('owner', scope, 1)).toBe(false)
  })

  it('moves between adjacent pending inputs without creating block handles', async () => {
    const prior = pending(), current = pending(), next = pending()
    document.body.append(prior, current, next)
    await navigatePendingProperty(current, scope, -1, ui)
    expect(document.activeElement).toBe(prior.querySelector('input'))
    await navigatePendingProperty(current, scope, 1, ui)
    expect(document.activeElement).toBe(next.querySelector('input'))
    expect(block).not.toHaveBeenCalled()
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
  })

  it('enters the nearest drawn real row in either direction, including lazy rows', async () => {
    const current = pending()
    document.body.append(real('prior'), current, real('next', scope, true))
    await navigatePendingProperty(current, scope, -1, ui)
    await navigatePendingProperty(current, scope, 1, ui)
    expect(vi.mocked(enterEditModeForBlock).mock.calls).toEqual([
      [{id: 'prior'}, ui, scope, {start: 0}],
      [{id: 'next'}, ui, scope, {start: 0}],
    ])
    expect(children).not.toHaveBeenCalled()
  })

  it('uses the enclosing drawn owner as the prior row', async () => {
    const owner = real('owner')
    const current = pending()
    owner.append(current)
    document.body.append(owner)
    await navigatePendingProperty(current, scope, -1, ui)
    expect(enterEditModeForBlock).toHaveBeenCalledWith({id: 'owner'}, ui, scope, {start: 0})
    expect(children).not.toHaveBeenCalled()
  })

  it('ignores rows in another scope and hidden ancestors', async () => {
    const current = pending()
    const hidden = document.createElement('div')
    hidden.style.display = 'none'
    hidden.append(real('hidden'), pending())
    const invisible = document.createElement('div')
    invisible.style.visibility = 'hidden'
    invisible.append(real('invisible'))
    const target = pending()
    document.body.append(current, real('other', 'other'), pending('other'), hidden, invisible, target)
    await navigatePendingProperty(current, scope, 1, ui)
    expect(document.activeElement).toBe(target.querySelector('input'))
    expect(block).not.toHaveBeenCalled()
  })

  it('stops at the visible scope boundary without reading structural children', async () => {
    const current = pending()
    document.body.append(real('other-before', 'other'), current, real('other-after', 'other'))
    const input = current.querySelector('input')!
    input.focus()
    await navigatePendingProperty(current, scope, -1, ui)
    await navigatePendingProperty(current, scope, 1, ui)
    expect(document.activeElement).toBe(input)
    expect(block).not.toHaveBeenCalled()
    expect(children).not.toHaveBeenCalled()
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
  })
})
