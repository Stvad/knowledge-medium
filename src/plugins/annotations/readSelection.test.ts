// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {BlockPointerDependencies, ActionTrigger} from '@/shortcuts/types.js'
import {annotationActions, HIGHLIGHT_READ_SELECTION_ACTION_ID, keepSelectionOnClick} from './actions.ts'
import {locateReadSelection, type SelectionEnds} from './readSelection.ts'

/** Two rows as the outline draws them: a shell with chrome (the bullet) and a
 *  content slot; the second is being edited. */
const outline = () => {
  document.body.innerHTML = `
    <div data-block-shell="true" data-block-id="a" data-render-scope-id="panel:p:a">
      <span class="bullet">•</span>
      <div class="block-content"><div class="markdown-content"><p>alpha text</p></div></div>
    </div>
    <div data-block-shell="true" data-block-id="b" data-render-scope-id="panel:p:a">
      <div class="block-content"><div class="cm-editor"><div class="cm-line">beta text</div></div></div>
    </div>
    <div data-block-shell="true" data-block-id="c" data-render-scope-id="panel:p:a">
      <div class="block-content"><div class="markdown-content"><p>gamma text</p></div></div>
    </div>`
  const text = (selector: string) => document.querySelector(selector)!.firstChild!
  return {alpha: text('[data-block-id="a"] p'), bullet: text('.bullet'), beta: text('.cm-line'), gamma: text('[data-block-id="c"] p')}
}

const ends = (anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number): SelectionEnds =>
  ({anchorNode, anchorOffset, focusNode, focusOffset})

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('where a selection sits', () => {
  it('is one block when both ends are in its rendered content', () => {
    const {alpha} = outline()
    expect(locateReadSelection(ends(alpha, 0, alpha, 5))).toEqual({kind: 'block', blockId: 'a', renderScopeId: 'panel:p:a'})
  })

  it('is nothing when collapsed, or in an editor, which is edit mode', () => {
    const {alpha, beta} = outline()
    expect(locateReadSelection(ends(alpha, 2, alpha, 2))).toBeNull()
    expect(locateReadSelection(ends(beta, 0, beta, 4))).toBeNull()
  })

  it('is several when it spans blocks or leaves rendered content', () => {
    const {alpha, bullet, gamma} = outline()
    expect(locateReadSelection(ends(alpha, 0, gamma, 3))).toEqual({kind: 'several'})
    // The bullet is the row's chrome, not its text.
    expect(locateReadSelection(ends(alpha, 0, bullet, 1))).toEqual({kind: 'several'})
  })

  it('is several across two renderings of one block', () => {
    const {alpha, gamma} = outline()
    const shell = gamma.parentElement!.closest<HTMLElement>('[data-block-shell]')!
    shell.dataset.blockId = 'a'
    shell.dataset.renderScopeId = 'embed:a:panel:p:a'
    expect(locateReadSelection(ends(alpha, 0, gamma, 3))).toEqual({kind: 'several'})
  })
})

describe('a read-mode gesture', () => {
  const highlight = annotationActions.find(action => action.id === HIGHLIGHT_READ_SELECTION_ACTION_ID)!
  const canDispatch = () => highlight.canDispatch!({} as never)

  it('stands aside without a selection in rendered content, so an editor’s chord runs', () => {
    const {alpha, beta} = outline()
    expect(canDispatch()).toBe(false)
    document.getSelection()!.setBaseAndExtent(beta, 0, beta, 4)
    expect(canDispatch()).toBe(false)
    document.getSelection()!.setBaseAndExtent(alpha, 0, alpha, 4)
    expect(canDispatch()).toBe(true)
  })
})

describe('the click that ends a drag-select', () => {
  const click = (target: Element) => {
    const next = vi.fn()
    const deps = {targetElement: target} as unknown as BlockPointerDependencies
    keepSelectionOnClick.wrap(deps, {} as ActionTrigger, next)
    return next
  }

  const select = (node: Node, from: number, to: number) => {
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
  }

  it('does not enter edit mode while the clicked block holds a selection', () => {
    const {alpha} = outline()
    select(alpha, 0, 5)
    expect(click(alpha.parentElement!)).not.toHaveBeenCalled()
  })

  it('enters edit mode when nothing is selected, or the selection is in another block', () => {
    const {alpha, gamma} = outline()
    expect(click(alpha.parentElement!)).toHaveBeenCalled()
    select(gamma, 0, 5)
    expect(click(alpha.parentElement!)).toHaveBeenCalled()
  })
})
