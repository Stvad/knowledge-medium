// @vitest-environment happy-dom
//
// Drives the REAL extension: the transforms come out of the module's own
// contribution list, not a re-declaration of them here, so the test breaks if
// the decorator stops being wired to one of the three surfaces it claims.
//
// What it pins is the *latch*: reviewing a Readwise highlight is a one-time
// mark, and once marked the highlight stops intercepting the key at all — it
// falls through to the action's own handler (the todo cycle), so a reviewed
// highlight behaves like an ordinary block. The earlier version toggled
// `readwise:reviewed` on every press, which both un-reviewed on second press
// and made the underlying handler permanently unreachable on highlights.
import { describe, expect, it } from 'vitest'

import { actionTransformsFacet } from '@/extensions/core.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { typesProp } from '@/data/properties.js'
import { EDIT_MODE_TODO_CYCLE_ACTION_ID, TODO_CYCLE_ACTION_ID } from '@/plugins/todo/actions.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTransform,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import type { AnyPropertySeedDeclaration } from '@/data/api/index.js'

import readwiseContributions from './readwise.tsx'

// Wire-level constants: these are what actually sits in the user's DB, so a
// test fixture that spells them out is pinning the contract, not the code.
const HIGHLIGHT_TYPE = 'readwise-highlight'
const REVIEWED_PROP = 'readwise:reviewed'

const valuesOf = (facetId: string) =>
  readwiseContributions.filter(c => c.facet.id === facetId).map(c => c.value)

const reviewedSchema = (valuesOf(definitionSeedsFacet.id) as AnyPropertySeedDeclaration[])
  .find(schema => schema.name === REVIEWED_PROP)!

const transforms = valuesOf(actionTransformsFacet.id) as ActionTransform[]

/** A stand-in for whatever action is being decorated. Records whether the
 *  original handler ran — i.e. whether the keypress fell through. */
const baseAction = (actionId: string) => {
  const ran: string[] = []
  const action: ActionConfig = {
    id: actionId,
    description: 'base',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async () => { ran.push('base') },
  }
  return { action, ran }
}

const blockWith = (properties: Record<string, unknown>) => {
  const writes: Array<[string, unknown]> = []
  const data = { id: 'h1', properties }
  return {
    writes,
    block: {
      id: 'h1',
      repo: { isReadOnly: false },
      peek: () => data,
      load: async () => data,
      set: async (schema: { name: string }, value: unknown) => {
        writes.push([schema.name, value])
        properties[schema.name] = reviewedSchema.codec.encode(value as never)
      },
    },
  }
}

const highlightProps = (extra: Record<string, unknown> = {}) => ({
  [typesProp.name]: typesProp.codec.encode([HIGHLIGHT_TYPE]),
  ...extra,
})

const press = async (transform: ActionTransform, actionId: string, block: unknown) => {
  const { action, ran } = baseAction(actionId)
  const decorated = transform.apply(action)!
  await decorated.handler({ block } as unknown as BlockShortcutDependencies, {
    type: 'programmatic',
  } as never)
  return ran
}

// Every surface the extension decorates. All three share the latch, so all
// three are exercised — a decorator dropped from one of them fails here.
const SURFACES = [
  { name: 'normal-mode todo cycle', actionId: TODO_CYCLE_ACTION_ID },
  { name: 'edit-mode todo cycle', actionId: EDIT_MODE_TODO_CYCLE_ACTION_ID },
  { name: 'swipe right', actionId: SWIPE_RIGHT_BLOCK_ACTION_ID },
] as const

describe.each(SURFACES)('readwise review latch on $name', ({ actionId }) => {
  const transform = transforms.find(t => t.actionId === actionId)!

  it('is contributed for this action', () => {
    expect(transform).toBeDefined()
  })

  it('marks an unreviewed highlight and consumes the press', async () => {
    const { block, writes } = blockWith(highlightProps())

    const ran = await press(transform, actionId, block)

    expect(writes).toEqual([[REVIEWED_PROP, true]])
    expect(ran).toEqual([])
  })

  it('falls through on an already-reviewed highlight, writing nothing', async () => {
    const { block, writes } = blockWith(highlightProps({
      [REVIEWED_PROP]: reviewedSchema.codec.encode(true as never),
    }))

    const ran = await press(transform, actionId, block)

    expect(writes).toEqual([])
    expect(ran).toEqual(['base'])
  })

  it('marks then falls through on the second press of the same block', async () => {
    const { block, writes } = blockWith(highlightProps())

    const first = await press(transform, actionId, block)
    const second = await press(transform, actionId, block)

    // One mark total — the second press neither re-writes nor un-reviews.
    expect(writes).toEqual([[REVIEWED_PROP, true]])
    expect(first).toEqual([])
    expect(second).toEqual(['base'])
  })

  it('leaves a non-highlight block entirely to the action', async () => {
    const { block, writes } = blockWith({})

    const ran = await press(transform, actionId, block)

    expect(writes).toEqual([])
    expect(ran).toEqual(['base'])
  })
})
