import { describe, expect, it } from 'vitest'
import type { Block } from '../../data/block'
import type { Repo } from '../../data/repo'
import type { BlockRenderer } from '@/types.ts'
import {
  blockClickHandlersFacet,
  BlockClickContribution,
  blockContentDecoratorsFacet,
  BlockContentDecoratorContribution,
  BlockInteractionContext,
  BlockResolveContext,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { codeMirrorEditModeActivation } from '@/extensions/defaultEditorInteractions.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

describe('block interaction facets', () => {
  it('lets a higher precedence click contribution replace baseline block clicks', () => {
    const baselineHandler = () => undefined
    const replacementHandler = () => undefined
    const baselineContribution: BlockClickContribution = () => baselineHandler
    const replacementContribution: BlockClickContribution = () => replacementHandler
    const runtime = resolveFacetRuntimeSync([
      blockClickHandlersFacet.of(baselineContribution),
      blockClickHandlersFacet.of(replacementContribution, {precedence: 100}),
    ])

    const handler = runtime.read(blockClickHandlersFacet)(context)

    expect(handler).toBe(replacementHandler)
  })

  it('defines CodeMirror edit mode through editor surface activations', () => {
    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation),
    ])

    const resolveActivations = runtime.read(shortcutSurfaceActivationsFacet)
    const editorView = {} as never

    expect(resolveActivations({
      ...context,
      surface: 'codemirror',
      editorView,
    })).toEqual([{
      context: ActionContextTypes.EDIT_MODE_CM,
      dependencies: {
        block: context.block,
        editorView,
      },
    }])
  })

  it('returns the inner renderer unchanged when no decorator contributions are registered', () => {
    const runtime = resolveFacetRuntimeSync([])
    const inner: BlockRenderer = () => null

    const decorate = runtime.read(blockContentDecoratorsFacet)

    expect(decorate(context, inner)).toBe(inner)
  })

  it('layers content decorators with the last contribution as the outermost wrapper', () => {
    const inner: BlockRenderer = () => null
    const tagged = (label: string): BlockContentDecoratorContribution => () => (Inner) => {
      const Wrapped: BlockRenderer = (props) => Inner(props)
      ;(Wrapped as { __layer?: string }).__layer = label
      ;(Wrapped as { __inner?: BlockRenderer }).__inner = Inner
      return Wrapped
    }

    const runtime = resolveFacetRuntimeSync([
      blockContentDecoratorsFacet.of(tagged('inner-most')),
      blockContentDecoratorsFacet.of(tagged('outer-most')),
    ])

    const decorated = runtime.read(blockContentDecoratorsFacet)(context, inner) as BlockRenderer & {
      __layer?: string
      __inner?: BlockRenderer & { __layer?: string; __inner?: BlockRenderer }
    }

    expect(decorated.__layer).toBe('outer-most')
    expect(decorated.__inner?.__layer).toBe('inner-most')
    expect(decorated.__inner?.__inner).toBe(inner)
  })

  it('respects facet precedence: lower precedence wraps closer to the inner renderer', () => {
    const inner: BlockRenderer = () => null
    const tagged = (label: string): BlockContentDecoratorContribution => () => (Inner) => {
      const Wrapped: BlockRenderer = (props) => Inner(props)
      ;(Wrapped as { __layer?: string }).__layer = label
      ;(Wrapped as { __inner?: BlockRenderer }).__inner = Inner
      return Wrapped
    }

    const runtime = resolveFacetRuntimeSync([
      blockContentDecoratorsFacet.of(tagged('outer-most'), {precedence: 100}),
      blockContentDecoratorsFacet.of(tagged('inner-most'), {precedence: 0}),
    ])

    const decorated = runtime.read(blockContentDecoratorsFacet)(context, inner) as BlockRenderer & {
      __layer?: string
      __inner?: BlockRenderer & { __layer?: string }
    }

    expect(decorated.__layer).toBe('outer-most')
    expect(decorated.__inner?.__layer).toBe('inner-most')
  })

  it('skips decorators that return null/undefined/false for the given block', () => {
    const inner: BlockRenderer = () => null
    const skip: BlockContentDecoratorContribution = () => null
    const wrap: BlockContentDecoratorContribution = () => (Inner) => {
      const Wrapped: BlockRenderer = (props) => Inner(props)
      ;(Wrapped as { __wrapped?: boolean }).__wrapped = true
      return Wrapped
    }

    const runtime = resolveFacetRuntimeSync([
      blockContentDecoratorsFacet.of(skip),
      blockContentDecoratorsFacet.of(wrap),
    ])

    const decorated = runtime.read(blockContentDecoratorsFacet)(context, inner) as BlockRenderer & {
      __wrapped?: boolean
    }

    expect(decorated.__wrapped).toBe(true)
    expect(decorated).not.toBe(inner)
  })

  it('passes the block-interaction context to each decorator contribution', () => {
    const inner: BlockRenderer = () => null
    const seen: BlockResolveContext[] = []
    const observer: BlockContentDecoratorContribution = (ctx) => {
      seen.push(ctx)
      return null
    }

    const runtime = resolveFacetRuntimeSync([
      blockContentDecoratorsFacet.of(observer),
    ])

    runtime.read(blockContentDecoratorsFacet)(context, inner)

    expect(seen).toEqual([context])
  })

  it('allows a contribution to introduce an application-specific mode', () => {
    const customModeActivation: ShortcutActivationContribution = activationContext =>
      activationContext.surface === 'block'
        ? [{
          context: 'custom-mode',
          dependencies: {
            block: activationContext.block,
          },
        }]
        : null

    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(customModeActivation),
    ])

    expect(runtime.read(shortcutSurfaceActivationsFacet)({
      ...context,
      surface: 'block',
    })).toEqual([{
      context: 'custom-mode',
      dependencies: {
        block: context.block,
      },
    }])
  })
})
