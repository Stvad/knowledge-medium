/** The one owner of a block's gutter: the items plugins contribute to
 *  `blockGutterItemsFacet`, laid out in the corners of the block's content.
 *
 *  The host wraps the decorated content and never changes the tree above it,
 *  so an item appearing or disappearing never remounts the text. The top-right
 *  cluster takes room in one of three ways (`blockGutterMode.ts`); the
 *  bottom-right cluster always reserves a row under the content (CSS only, in
 *  `index.css`). */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Block } from '@/data/block'
import type { BlockRenderer } from '@/types.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import {
  blockGutterItemsFacet,
  type BlockGutterItem,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import {
  decideGutterTopMode,
  INITIAL_GUTTER_TOP_STATE,
  type GutterTopMeasure,
  type GutterTopState,
} from './blockGutterMode.ts'

/** The clusters' `gap`, kept between the text and the top cluster too. */
const ITEM_GAP_PX = 4

const NO_TEXT_STATE: GutterTopState = {mode: 'none', stuckKey: null}

interface GutterMeasurement {
  /** Room the top cluster needs, gap included; 0 when nothing shows. */
  width: number
  lineHeight: number | null
  top: GutterTopMeasure | null
}

class GutterController {
  private host: HTMLElement | null = null
  private cluster: HTMLElement | null = null
  private text: HTMLElement | null = null
  private observedText: HTMLElement | null = null
  private generation = 0
  private state: GutterTopState = NO_TEXT_STATE
  private appliedWidth = 0

  readonly setHost = (element: HTMLDivElement | null) => {
    this.host = element
    this.writeMode()
  }

  readonly setCluster = (element: HTMLDivElement | null) => {
    if (this.cluster) unobserve(this.cluster)
    this.cluster = element
    if (element) {
      observe(element, this)
      return
    }
    this.apply({width: 0, lineHeight: null, top: null})
  }

  registerText(element: HTMLElement): () => void {
    this.replaceText(element)
    return () => {
      if (this.text === element) this.replaceText(null)
    }
  }

  /** Reads only; `apply` writes. The shared observer reads every host before
   *  it writes any, since interleaving them costs a layout per host. */
  measure(): GutterMeasurement | null {
    if (!this.host || !this.cluster) return null
    const clusterWidth = this.cluster.getBoundingClientRect().width
    const width = clusterWidth > 0 ? Math.ceil(clusterWidth) + ITEM_GAP_PX : 0
    if (width === 0 || !this.text) return {width, lineHeight: null, top: null}
    const hostRect = this.host.getBoundingClientRect()
    const textRect = this.text.getBoundingClientRect()
    const lineHeight = Number.parseFloat(getComputedStyle(this.text).lineHeight)
    const padding = this.state.mode === 'column' ? this.appliedWidth : 0
    return {
      width,
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
      top: {
        hasText: true,
        topGap: textRect.top - hostRect.top,
        rightGap: hostRect.right - padding - textRect.right,
        key: `${Math.round(hostRect.width)}|${width}|${this.generation}`,
      },
    }
  }

  apply({width, lineHeight, top}: GutterMeasurement) {
    const host = this.host
    if (!host) return
    host.style.setProperty('--km-gutter-top-w', `${width}px`)
    if (lineHeight === null) host.style.removeProperty('--km-gutter-line')
    else host.style.setProperty('--km-gutter-line', `${lineHeight}px`)
    this.appliedWidth = width
    // With nothing showing there is no corner to protect; the next item that
    // shows starts the decision over.
    this.state = top ? decideGutterTopMode(this.state, top) : this.restingState()
    this.writeMode()
    this.observeText(width > 0 ? this.text : null)
  }

  private replaceText(element: HTMLElement | null) {
    this.text?.removeAttribute('data-gutter-flow')
    this.observeText(null)
    this.text = element
    this.generation += 1
    this.state = this.restingState()
    this.writeMode()
    if (this.cluster) remeasure(this.cluster)
  }

  private restingState(): GutterTopState {
    return this.text ? INITIAL_GUTTER_TOP_STATE : NO_TEXT_STATE
  }

  private writeMode() {
    this.host?.setAttribute('data-gutter-top', this.state.mode)
    this.text?.toggleAttribute('data-gutter-flow', this.state.mode === 'flow')
  }

  private observeText(element: HTMLElement | null) {
    if (this.observedText === element) return
    if (this.observedText) unobserve(this.observedText)
    this.observedText = element
    if (element) observe(element, this)
  }
}

const controllers = new WeakMap<Element, GutterController>()
let sharedObserver: ResizeObserver | undefined

const gutterObserver = (): ResizeObserver | undefined => {
  if (typeof ResizeObserver === 'undefined') return undefined
  sharedObserver ??= new ResizeObserver(entries => {
    const due = new Set<GutterController>()
    for (const entry of entries) {
      const controller = controllers.get(entry.target)
      if (controller) due.add(controller)
    }
    const measured = [...due].map(controller => [controller, controller.measure()] as const)
    for (const [controller, measurement] of measured) {
      if (measurement) controller.apply(measurement)
    }
  })
  return sharedObserver
}

const observe = (element: Element, controller: GutterController) => {
  controllers.set(element, controller)
  gutterObserver()?.observe(element)
}

const unobserve = (element: Element) => {
  controllers.delete(element)
  gutterObserver()?.unobserve(element)
}

/** Re-observing delivers a fresh notification for an element that has a size,
 *  which routes a registration change through the same batched read/write. */
const remeasure = (element: Element) => {
  const observer = gutterObserver()
  observer?.unobserve(element)
  observer?.observe(element)
}

/** What a text renderer under a host may reach: whose corner it is, and the
 *  registration. */
interface GutterTextTarget {
  blockId: string
  registerText: (element: HTMLElement) => () => void
}

const GutterContext = createContext<GutterTextTarget | null>(null)

/** For a renderer that draws the block's own text. Returns a callback ref for
 *  the text's element, or undefined when this render is not the block's text
 *  in its own host. A registered element whose text starts at the top-right
 *  corner gets `data-gutter-flow`, and the stylesheet keeps its first line
 *  clear of the cluster. */
export const useGutterText = (block: Block): ((element: HTMLElement | null) => void) | undefined => {
  const target = useContext(GutterContext)
  const registration = useRef<{element: HTMLElement; release: () => void} | null>(null)
  const attach = useCallback((element: HTMLElement | null) => {
    // null is a detach, handled by the cleanup below; the same element again
    // is a re-attached callback ref and keeps its registration.
    if (!target || !element || registration.current?.element === element) return
    registration.current?.release()
    registration.current = {element, release: target.registerText(element)}
  }, [target])
  useLayoutEffect(() => () => {
    registration.current?.release()
    registration.current = null
  }, [target])
  // Defence in depth: no renderer draws another block's text under a host
  // today, but one that did must not take this block's corner.
  return target?.blockId === block.id ? attach : undefined
}

/** Hands the host an item that the layout itself owns — the mobile expand
 *  button, which only means something to a layout that collapses. Rendered
 *  last, so it is the rightmost item. */
export interface GutterControls {
  subscribe: (listener: () => void) => () => void
  get: () => BlockRenderer | null
  set: (item: BlockRenderer | null) => void
}

export const createGutterControls = (): GutterControls => {
  let current: BlockRenderer | null = null
  const listeners = new CallbackSet('gutter controls')
  return {
    subscribe: listener => listeners.add(listener),
    get: () => current,
    set: item => {
      if (item === current) return
      current = item
      listeners.notify()
    },
  }
}

export const useGutterControlsItem = (controls: GutterControls, item: BlockRenderer | null) => {
  useLayoutEffect(() => {
    controls.set(item)
    return () => controls.set(null)
  }, [controls, item])
}

/** Breadcrumbs and inline references show the block as a citation of
 *  another surface, not as itself. */
const showsGutter = ({blockContext}: BlockResolveContext): boolean =>
  !blockContext?.isBreadcrumb && !blockContext?.isReference

const GutterItemSlot = ({Item, block, overlay = false}: {
  Item: BlockRenderer
  block: Block
  /** May draw over non-text content rather than have a row reserved for it. */
  overlay?: boolean
}) => (
  <span data-gutter-item="" data-gutter-overlay={overlay ? '' : undefined} className="contents">
    <ExtensionRenderBoundary>
      <Item block={block}/>
    </ExtensionRenderBoundary>
  </span>
)

const itemsIn = (items: readonly BlockGutterItem[], corner: BlockGutterItem['corner']) =>
  items.filter(item => item.corner === corner)

export function BlockGutterHost({resolveContext, controls, children}: {
  resolveContext: BlockResolveContext
  controls: GutterControls
  children: ReactNode
}) {
  const {block} = resolveContext
  const runtime = useAppRuntime()
  const resolveItems = runtime.read(blockGutterItemsFacet)
  const items = useMemo(() => resolveItems(resolveContext), [resolveItems, resolveContext])
  const ControlsItem = useSyncExternalStore(controls.subscribe, controls.get)
  const [controller] = useState(() => new GutterController())
  const setHost = useCallback((element: HTMLDivElement | null) => controller.setHost(element), [controller])
  const setCluster = useCallback((element: HTMLDivElement | null) => controller.setCluster(element), [controller])
  const target = useMemo<GutterTextTarget>(() => ({
    blockId: block.id,
    registerText: element => controller.registerText(element),
  }), [controller, block.id])

  if (!showsGutter(resolveContext)) return <GutterContext value={null}>{children}</GutterContext>

  const top = itemsIn(items, 'top-right')
  const bottom = itemsIn(items, 'bottom-right')
  return (
    <GutterContext value={target}>
      <div ref={setHost} className="km-gutter-host">
        {children}
        {(top.length > 0 || ControlsItem) && (
          <div ref={setCluster} className="km-gutter-top">
            {top.map((item, index) => <GutterItemSlot key={index} Item={item.component} block={block}/>)}
            {ControlsItem && <GutterItemSlot key="controls" Item={ControlsItem} block={block} overlay/>}
          </div>
        )}
        {bottom.length > 0 && (
          <div className="km-gutter-bottom">
            {bottom.map((item, index) => <GutterItemSlot key={index} Item={item.component} block={block}/>)}
          </div>
        )}
      </div>
    </GutterContext>
  )
}
