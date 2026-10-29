// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOUCH_HOLD_MS,
  TOUCH_SLOP_PX,
  type GestureEventContext,
  type GesturePointer,
  type GestureRecognizer,
  type GestureSession,
} from '@/extensions/continuousGestures.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { Block } from '@/data/block'
import { focusedBlockLocationProp, isEditingProp } from '@/data/properties.js'
import { BLOCK_HOLD_GESTURE, blockHoldRecognizer } from '../holdRecognizer.ts'

interface Setup {
  editing?: boolean
  readOnly?: boolean
}

const context = ({editing = false, readOnly = false}: Setup = {}): BlockResolveContext => {
  const properties = editing
    ? {[focusedBlockLocationProp.name]: {blockId: 'b1', renderScopeId: 'scope'}}
    : {}
  return {
    block: {id: 'b1'} as Block,
    uiStateBlock: {
      repo: {isReadOnly: readOnly},
      peek: () => ({properties}),
      peekProperty: (prop: {name: string}) => (prop.name === isEditingProp.name ? editing : undefined),
    } as unknown as Block,
    scopeRootId: 'root',
    blockContext: {renderScopeId: 'scope'},
  } as unknown as BlockResolveContext
}

const make = (setup?: Setup): GestureRecognizer => {
  const recognizer = blockHoldRecognizer(context(setup))
  if (!recognizer) throw new Error('recognizer not contributed')
  return recognizer
}

const pointer = (pointerId: number, x: number, y: number): GesturePointer =>
  ({pointerId, x, y, pointerType: 'touch', target: null})

const session = (changed: GesturePointer, all: readonly GesturePointer[] = [changed]): GestureSession =>
  ({pointers: all, changed})

const eventCtx = ({pointerType = 'touch', target = null as EventTarget | null} = {}): GestureEventContext =>
  ({element: document.createElement('div'), event: {pointerType, target} as unknown as PointerEvent})

const press = (recognizer: GestureRecognizer, ctx = eventCtx()) =>
  recognizer.onPointerDown?.(session(pointer(1, 100, 100)), ctx)

const hold = (recognizer: GestureRecognizer) =>
  recognizer.onHold?.(session(pointer(1, 100, 100)), eventCtx())

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({matches: true}) as unknown as typeof window.matchMedia
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('blockHoldRecognizer', () => {
  it('holds for the shared touch hold', () => {
    expect(make().holdMs).toBe(TOUCH_HOLD_MS)
  })

  it('commits a block hold with the held block\'s pointer deps', () => {
    const recognizer = make()
    press(recognizer)
    const verdict = hold(recognizer)
    if (verdict?.status !== 'commit') throw new Error(`expected commit, got ${verdict?.status}`)
    expect(verdict.gesture).toBe(BLOCK_HOLD_GESTURE)
    expect(verdict.deps).toMatchObject({
      block: {id: 'b1'},
      scopeRootId: 'root',
      renderScopeId: 'scope',
      targetElement: expect.any(HTMLElement),
    })
  })

  it('commits after a wobble inside the slop', () => {
    const recognizer = make()
    press(recognizer)
    recognizer.onPointerMove?.(session(pointer(1, 100 + TOUCH_SLOP_PX, 100)), eventCtx())
    expect(hold(recognizer)?.status).toBe('commit')
  })

  it('gives up once the finger travels past the slop: that touch is a scroll or a swipe', () => {
    const recognizer = make()
    press(recognizer)
    const verdict = recognizer.onPointerMove?.(session(pointer(1, 100, 100 + TOUCH_SLOP_PX + 1)), eventCtx())
    expect(verdict?.status).toBe('cancel')
    expect(hold(recognizer)?.status).toBe('idle')
  })

  it('ignores a mouse or pen press', () => {
    for (const pointerType of ['mouse', 'pen']) {
      const recognizer = make()
      press(recognizer, eventCtx({pointerType}))
      expect(hold(recognizer)?.status).toBe('idle')
    }
  })

  it('gives up when a second finger lands (the date scrub\'s gesture)', () => {
    const recognizer = make()
    press(recognizer)
    const second = pointer(2, 150, 100)
    const verdict = recognizer.onPointerDown?.(session(second, [pointer(1, 100, 100), second]), eventCtx())
    expect(verdict?.status).toBe('cancel')
    expect(hold(recognizer)?.status).toBe('idle')
  })

  it('leaves a press on a button alone, but takes one on a link', () => {
    const button = document.createElement('button')
    const onButton = make()
    press(onButton, eventCtx({target: button}))
    expect(hold(onButton)?.status).toBe('idle')

    const link = document.createElement('a')
    link.href = '#x'
    const onLink = make()
    press(onLink, eventCtx({target: link}))
    expect(hold(onLink)?.status).toBe('commit')
  })

  it('starts every press over: one on a button after a tap on text holds nothing', () => {
    const recognizer = make()
    press(recognizer)
    press(recognizer, eventCtx({target: document.createElement('button')}))
    expect(hold(recognizer)?.status).toBe('idle')
  })

  it('forgets the press when the loop cancels it (a rival claimed the block, or iOS took the touch)', () => {
    const recognizer = make()
    press(recognizer)
    recognizer.onPointerCancel?.(session(pointer(1, 100, 100)), eventCtx())
    expect(hold(recognizer)?.status).toBe('idle')
  })

  it('commits a press only once', () => {
    const recognizer = make()
    press(recognizer)
    hold(recognizer)
    expect(hold(recognizer)?.status).toBe('idle')
  })

  describe('isEnabled', () => {
    it('is on for a touch-primary device reading a writable block', () => {
      expect(make().isEnabled?.()).toBe(true)
    })

    it('is off without a coarse pointer, where read-mode text keeps its native hold', () => {
      window.matchMedia = vi.fn().mockReturnValue({matches: false}) as unknown as typeof window.matchMedia
      expect(make().isEnabled?.()).toBe(false)
    })

    it('is off while the block is being edited: a hold there selects text', () => {
      expect(make({editing: true}).isEnabled?.()).toBe(false)
    })

    it('is off in a read-only workspace, where native selection is the only way to copy text', () => {
      expect(make({readOnly: true}).isEnabled?.()).toBe(false)
    })
  })
})
