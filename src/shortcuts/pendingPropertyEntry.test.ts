// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {EditorView} from '@codemirror/view'
import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import {getDefaultActions} from './defaultShortcuts'
import {getVimNormalModeActions} from '@/plugins/vim-normal-mode/actions'
import {nextVisibleBlock, previousVisibleBlock} from '@/utils/selection'
import {isOnFirstVisualLine, isOnLastVisualLine} from '@/utils/codemirror'
import {ActionContextTypes, type ActionTrigger, type CodeMirrorEditModeDependencies} from './types'

vi.mock('@/utils/selection', async importOriginal => ({
  ...await importOriginal<object>(),
  nextVisibleBlock: vi.fn(async () => null),
  previousVisibleBlock: vi.fn(async () => null),
}))
vi.mock('@/utils/codemirror', async importOriginal => ({
  ...await importOriginal<object>(),
  isOnFirstVisualLine: vi.fn(() => true),
  isOnLastVisualLine: vi.fn(() => true),
  getCaretRect: vi.fn(),
}))

const scope = 'outline:current'
const repo = {} as Repo
const block = {id: 'current'} as Block
const deps = {
  block, uiStateBlock: {} as Block, scopeRootId: 'root', renderScopeId: scope,
  editorView: {} as EditorView,
} as CodeMirrorEditModeDependencies
const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

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
const pending = (renderScopeId = scope) => {
  const row = document.createElement('div')
  row.dataset.pendingPropertyScopeId = renderScopeId
  row.append(document.createElement('input'))
  return row
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {document.body.replaceChildren()})

describe.each([
  {mode: 'CodeMirror', direction: -1, id: 'move_up_from_cm_start'},
  {mode: 'CodeMirror', direction: 1, id: 'move_down_from_cm_end'},
  {mode: 'normal', direction: -1, id: 'move_up'},
  {mode: 'normal', direction: 1, id: 'move_down'},
] as const)('$mode $id pending property entry', ({mode, direction, id}) => {
  const dispatch = async (overrides: Partial<CodeMirrorEditModeDependencies> = {}) => {
    if (mode === 'CodeMirror') {
      const action = getDefaultActions({repo}).find(candidate =>
        candidate.id === id && candidate.context === ActionContextTypes.EDIT_MODE_CM)
      if (!action || action.context !== ActionContextTypes.EDIT_MODE_CM) throw new Error(`Missing ${id}`)
      await action.handler({...deps, ...overrides}, trigger)
    } else {
      const action = getVimNormalModeActions({repo}).find(candidate => candidate.id === id)
      if (!action) throw new Error(`Missing ${id}`)
      await action.handler({...deps, ...overrides}, trigger)
    }
  }
  const draw = (...neighbours: HTMLElement[]) => {
    const current = real(block.id)
    document.body.append(...(direction < 0 ? [...neighbours].reverse().concat(current) : [current, ...neighbours]))
  }
  const walk = () => direction < 0 ? previousVisibleBlock : nextVisibleBlock

  it('focuses the immediately drawn pending input before any structural walk', async () => {
    const target = pending()
    draw(target)
    await dispatch()
    expect(document.activeElement).toBe(target.querySelector('input'))
    expect(walk()).not.toHaveBeenCalled()
    if (mode === 'CodeMirror') expect(trigger.preventDefault).toHaveBeenCalledOnce()
    expect(target.hasAttribute('data-block-id')).toBe(false)
  })

  it.each([false, true])('lets the existing walk handle a nearer real row (lazy=%s)', async lazy => {
    const farther = pending()
    const nearer = real('nearer', scope, lazy)
    const input = document.createElement('input')
    nearer.append(input)
    draw(nearer, farther)
    await dispatch()
    expect(document.activeElement).not.toBe(input)
    expect(document.activeElement).not.toBe(farther.querySelector('input'))
    expect(walk()).toHaveBeenCalledOnce()
  })

  it('ignores hidden rows and rows from other render scopes', async () => {
    const hidden = document.createElement('div')
    hidden.style.display = 'none'
    hidden.append(real('hidden'), pending())
    const target = pending()
    draw(real('other', 'other'), pending('other'), hidden, target)
    await dispatch()
    expect(document.activeElement).toBe(target.querySelector('input'))
    expect(walk()).not.toHaveBeenCalled()
  })

  it('leaves another render scope to the existing walk', async () => {
    const other = pending('other')
    draw(other)
    await dispatch()
    expect(document.activeElement).not.toBe(other.querySelector('input'))
    expect(walk()).toHaveBeenCalledOnce()
  })

  it('leaves navigation without a rendered scope to the existing walk', async () => {
    const target = pending()
    draw(target)
    await dispatch({renderScopeId: undefined})
    expect(document.activeElement).not.toBe(target.querySelector('input'))
    expect(walk()).toHaveBeenCalledOnce()
  })

  if (mode === 'CodeMirror') {
    it('keeps an interior visual-line move inside CodeMirror', async () => {
      const target = pending()
      draw(target)
      const boundary = direction < 0 ? isOnFirstVisualLine : isOnLastVisualLine
      vi.mocked(boundary).mockReturnValueOnce(false)
      await dispatch()
      expect(document.activeElement).not.toBe(target.querySelector('input'))
      expect(trigger.preventDefault).not.toHaveBeenCalled()
      expect(walk()).not.toHaveBeenCalled()
    })
  }
})
