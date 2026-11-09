// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import type {Ref} from 'react'
import {MessageSquarePlus} from 'lucide-react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {AnnotationSurfaceContext, type AnnotationSurface, type SurfaceHighlight} from '@/plugins/annotations/surface.ts'
import {showInfo} from '@/utils/toast.js'
import type {FrameMark, FrameSelection} from '../frameDocument.ts'
import {AnnotatedFrame} from '../frameAnnotations.tsx'

interface FrameProps {
  marks?: readonly FrameMark[]
  onSelection?: (selection: FrameSelection | null) => void
  ref?: Ref<{clearSelection: () => void}>
}

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
}))

const SOURCE = '<p>one two</p>'
const RECT = {top: 10, left: 10, bottom: 20, right: 40}

/** `two` in the paragraph, as the frame would report it. */
const selectTwo = (text = 'one two') => act(() => frame.props!.onSelection!({
  start: {text, occurrence: 0, count: 1, offset: 4},
  end: {text, occurrence: 0, count: 1, offset: 7},
  rect: RECT,
}))

const highlightTwo = (content: string): SurfaceHighlight[] => {
  const from = content.indexOf('two')
  return [{from, to: from + 3, moved: false, suggestion: false}]
}

const NO_HIGHLIGHTS = (): SurfaceHighlight[] => []

const surfaceRunning = (run: () => Promise<boolean>, highlightsIn: (content: string) => SurfaceHighlight[] = NO_HIGHLIGHTS): AnnotationSurface => ({
  blockId: 'doc',
  renderScopeId: undefined,
  highlightsIn,
  gestures: [{id: 'comment', label: 'Comment', icon: MessageSquarePlus, run}],
})

const framed = (surface: AnnotationSurface | null, source = SOURCE) =>
  <AnnotationSurfaceContext value={surface}><AnnotatedFrame blockId="doc" source={source} scripts="hold"/></AnnotationSurfaceContext>

const renderWith = (surface: AnnotationSurface | null, source = SOURCE) => render(framed(surface, source))

describe('AnnotatedFrame', () => {
  beforeEach(() => {
    frame.props = undefined
    frame.clearSelection.mockReset()
    vi.mocked(showInfo).mockReset()
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
    await waitFor(() => expect(frame.props?.marks).toHaveLength(1))
    selectTwo()
    fireEvent.click(screen.getByRole('button', {name: 'Comment'}))
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs a gesture on the selection as a range of the source, then drops the selection', async () => {
    const run = vi.fn(async () => true)
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(screen.getByRole('button', {name: 'Comment'}))
    await waitFor(() => expect(frame.clearSelection).toHaveBeenCalledOnce())
    expect(run).toHaveBeenCalledWith({content: SOURCE, from: SOURCE.indexOf('two'), to: SOURCE.indexOf('two') + 3})
  })

  it('keeps the selection when the gesture does not land', async () => {
    const run = vi.fn(async () => false)
    renderWith(surfaceRunning(run))
    selectTwo()
    fireEvent.click(screen.getByRole('button', {name: 'Comment'}))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(frame.clearSelection).not.toHaveBeenCalled()
  })

  it('says why, and runs nothing, for a selection it cannot place in the source', async () => {
    const run = vi.fn(async () => true)
    renderWith(surfaceRunning(run))
    selectTwo('text a script wrote')
    fireEvent.click(screen.getByRole('button', {name: 'Comment'}))
    await waitFor(() => expect(showInfo).toHaveBeenCalledOnce())
    expect(run).not.toHaveBeenCalled()
    expect(frame.clearSelection).not.toHaveBeenCalled()
  })

  it('runs one gesture at a time on a selection', async () => {
    let land!: (landed: boolean) => void
    const run = vi.fn(() => new Promise<boolean>(resolve => { land = resolve }))
    renderWith(surfaceRunning(run))
    selectTwo()
    const button = screen.getByRole('button', {name: 'Comment'})
    fireEvent.click(button)
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    await act(async () => land(false))
    expect(run).toHaveBeenCalledOnce()
    expect(button).toHaveProperty('disabled', false)
  })

  it('hides the gestures once the frame reports no selection', () => {
    renderWith(surfaceRunning(async () => true))
    selectTwo()
    expect(screen.queryByRole('toolbar')).not.toBeNull()
    act(() => frame.props!.onSelection!(null))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('drops marks for an older source even when the surface hands back the same highlights', async () => {
    const fixed = highlightTwo(SOURCE)
    const surface = surfaceRunning(async () => true, () => fixed)
    const {rerender} = renderWith(surface)
    await waitFor(() => expect(frame.props?.marks).toHaveLength(1))
    rerender(framed(surface, `<p>zero</p>${SOURCE}`))
    expect(frame.props?.marks).toEqual([])
  })

  it('hands the frame the surface\'s highlights, none once they are gone, and never an older source\'s', async () => {
    const surface = surfaceRunning(async () => true, highlightTwo)
    const {rerender} = renderWith(surface)
    await waitFor(() => expect(frame.props?.marks).toEqual([
      {start: {node: 0, offset: 4}, end: {node: 0, offset: 7}, kind: 'comment'},
    ]))

    const resolved = surfaceRunning(async () => true)
    rerender(framed(resolved))
    expect(frame.props?.marks).toEqual([])

    rerender(framed(surface))
    await waitFor(() => expect(frame.props?.marks).toHaveLength(1))
    rerender(framed(surface, `<p>zero</p>${SOURCE}`))
    expect(frame.props?.marks).toEqual([
      {start: {node: 1, offset: 4}, end: {node: 1, offset: 7}, kind: 'comment'},
    ])
  })
})
