// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import type {ComponentProps} from 'react'
import {MessageSquarePlus} from 'lucide-react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {AnnotationSurfaceContext, type AnnotationSurface, type HighlightRange} from '@/plugins/annotations/surface.ts'
import {showError, showInfo} from '@/utils/toast.js'
import {NO_MARKS, textDigest, type FrameScripts} from '../frameDocument.ts'
import {AnnotatedFrame, gesturesPlacement} from '../frameAnnotations.tsx'
import type {HtmlFrame} from '../HtmlFrame.tsx'

type FrameProps = ComponentProps<typeof HtmlFrame>

const frame = vi.hoisted(() => ({props: undefined as FrameProps | undefined, clearSelection: vi.fn()}))

vi.mock('../HtmlFrame.tsx', async () => {
  const {useImperativeHandle} = await vi.importActual<typeof import('react')>('react')
  return {
    HtmlFrame: (props: FrameProps) => {
      frame.props = props
      useImperativeHandle(props.ref, () => ({clearSelection: frame.clearSelection}))
      return null
    },
  }
})

vi.mock('@/utils/toast.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/toast.js')>(),
  showInfo: vi.fn(),
  showError: vi.fn(),
}))

const SOURCE = '<p>one two</p>'
const RECT = {top: 10, left: 10, bottom: 20, right: 40}

/** `two` in the paragraph, as a frame holding exactly the source's text reports it. */
const selectTwo = (text = 'one two') => act(() => frame.props!.onSelection!({
  start: {text, occurrence: 0, count: 1, offset: 4},
  end: {text, occurrence: 0, count: 1, offset: 7},
  rect: RECT,
  digest: textDigest(['one two']),
}))

const highlightTwo = (content: string): HighlightRange[] => {
  const from = content.indexOf('two')
  return [{from, to: from + 3, moved: false, suggestion: false}]
}

const NO_HIGHLIGHTS = (): HighlightRange[] => []

const surfaceRunning = (run: () => Promise<boolean>, highlightsIn: (content: string) => HighlightRange[] = NO_HIGHLIGHTS): AnnotationSurface => ({
  blockId: 'doc',
  renderScopeId: undefined,
  highlightsIn,
  gestures: [{id: 'comment', label: 'Comment', icon: MessageSquarePlus, run}],
})

const framed = (surface: AnnotationSurface | null, source = SOURCE, scripts: FrameScripts = 'hold') =>
  <AnnotationSurfaceContext value={surface}><AnnotatedFrame blockId="doc" source={source} scripts={scripts}/></AnnotationSurfaceContext>

const renderWith = (surface: AnnotationSurface | null, source = SOURCE) => render(framed(surface, source))

const comment = () => screen.getByRole('button', {name: 'Comment'})

describe('AnnotatedFrame', () => {
  beforeEach(() => {
    frame.props = undefined
    frame.clearSelection.mockReset()
    vi.mocked(showInfo).mockReset()
    vi.mocked(showError).mockReset()
  })
  afterEach(cleanup)

  it('listens for no selection where nothing annotates the block', () => {
    renderWith(null)
    expect(frame.props?.onSelection).toBeUndefined()
  })

  it('takes no surface provided for another block, as an embed inside that block would', () => {
    renderWith({...surfaceRunning(async () => true), blockId: 'outer'})
    expect(frame.props?.onSelection).toBeUndefined()
  })

  it('starts the gesture inside the click once the source map has loaded', async () => {
    const run = vi.fn(async () => true)
    renderWith(surfaceRunning(run, highlightTwo))
    await waitFor(() => expect(frame.props?.marks?.marks).toHaveLength(1))
    selectTwo()
    fireEvent.click(comment())
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs a gesture on the selection as a range of the source, then drops the selection', async () => {
    const run = vi.fn(async () => true)
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(comment())
    await waitFor(() => expect(frame.clearSelection).toHaveBeenCalledOnce())
    expect(run).toHaveBeenCalledWith({content: SOURCE, from: SOURCE.indexOf('two'), to: SOURCE.indexOf('two') + 3})
  })

  it('keeps the selection when the gesture does not land', async () => {
    const run = vi.fn(async () => false)
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(comment())
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(frame.clearSelection).not.toHaveBeenCalled()
  })

  it('says why, and runs nothing, for a selection it cannot place in the source', async () => {
    const run = vi.fn(async () => true)
    renderWith(surfaceRunning(run))
    selectTwo('text a script wrote')
    fireEvent.click(comment())
    await waitFor(() => expect(showInfo).toHaveBeenCalledOnce())
    expect(run).not.toHaveBeenCalled()
    expect(frame.clearSelection).not.toHaveBeenCalled()
  })

  it('runs one gesture at a time on a selection', async () => {
    let land!: (landed: boolean) => void
    const run = vi.fn(() => new Promise<boolean>(resolve => { land = resolve }))
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(comment())
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(comment()).toHaveProperty('disabled', true)
    fireEvent.click(comment())
    await act(async () => land(false))
    expect(run).toHaveBeenCalledOnce()
    expect(comment()).toHaveProperty('disabled', false)
  })

  it('reports a gesture that throws, and takes the next one', async () => {
    const run = vi.fn((): Promise<boolean> => { throw new Error('boom') })
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(comment())
    await waitFor(() => expect(showError).toHaveBeenCalledWith('boom'))
    expect(comment()).toHaveProperty('disabled', false)
  })

  it('hides the gestures once the frame reports no selection', () => {
    renderWith(surfaceRunning(async () => true))
    selectTwo()
    expect(screen.queryByRole('toolbar')).not.toBeNull()
    act(() => frame.props!.onSelection!(null))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('drops the selection on a press elsewhere in the app, not on one on the gestures', () => {
    renderWith(surfaceRunning(async () => true))
    selectTwo()
    fireEvent.pointerDown(comment())
    expect(frame.clearSelection).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(frame.clearSelection).toHaveBeenCalledOnce()
  })

  it('drops marks for an older source even when the surface hands back the same highlights', async () => {
    const fixed = highlightTwo(SOURCE)
    const surface = surfaceRunning(async () => true, () => fixed)
    const {rerender} = renderWith(surface)
    await waitFor(() => expect(frame.props?.marks?.marks).toHaveLength(1))
    rerender(framed(surface, `<p>zero</p>${SOURCE}`))
    expect(frame.props?.marks?.marks).toEqual([])
  })

  it('hands the frame the surface\'s highlights, none once they are gone, and never an older source\'s', async () => {
    const surface = surfaceRunning(async () => true, highlightTwo)
    const {rerender} = renderWith(surface)
    await waitFor(() => expect(frame.props?.marks).toEqual({
      digest: textDigest(['one two']),
      marks: [{start: {node: 0, offset: 4}, end: {node: 0, offset: 7}, kind: 'comment'}],
    }))

    rerender(framed(surfaceRunning(async () => true)))
    expect(frame.props?.marks).toBe(NO_MARKS)

    rerender(framed(surface, `<p>zero</p>${SOURCE}`))
    await waitFor(() => expect(frame.props?.marks?.marks).toEqual([
      {start: {node: 1, offset: 4}, end: {node: 1, offset: 7}, kind: 'comment'},
    ]))
  })

  it('places no marks for a running document, which is sent none', async () => {
    const surface = surfaceRunning(async () => true, highlightTwo)
    const {rerender} = renderWith(surface)
    await waitFor(() => expect(frame.props?.marks?.marks).toHaveLength(1))
    rerender(framed(surface, SOURCE, 'run'))
    expect(frame.props?.marks).toBe(NO_MARKS)
  })
})

describe('gesturesPlacement', () => {
  const FRAME = {width: 400, height: 300}
  const BAR = {width: 200, height: 30}
  const rect = (top: number, left: number, bottom = top + 10) => ({top, left, bottom, right: left + 50})

  it('goes below the selection, or above it where below runs out', () => {
    expect(gesturesPlacement(rect(10, 20), FRAME, BAR)).toEqual({top: 24, left: 20})
    expect(gesturesPlacement(rect(270, 20), FRAME, BAR)).toEqual({top: 236, left: 20})
  })

  it('stays inside the frame whatever the document reports', () => {
    expect(gesturesPlacement(rect(-5, 5000, 2), FRAME, BAR)).toBeNull()
    expect(gesturesPlacement({top: -40, left: 390, bottom: 1, right: 395}, FRAME, BAR)).toEqual({top: 5, left: 200})
    expect(gesturesPlacement({top: 0, left: 10, bottom: 300, right: 40}, FRAME, BAR)).toEqual({top: 0, left: 10})
  })

  it('is hidden while the selection is outside the frame', () => {
    expect(gesturesPlacement(rect(-40, 20, -25), FRAME, BAR)).toBeNull()
    expect(gesturesPlacement(rect(310, 20), FRAME, BAR)).toBeNull()
  })
})
