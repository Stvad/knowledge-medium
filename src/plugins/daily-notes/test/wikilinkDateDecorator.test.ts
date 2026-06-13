// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Fragment, createElement } from 'react'
import type { Block } from '@/data/block'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  isWikilinkDisplayParts,
  type WikilinkDisplayContext,
} from '@/plugins/references/markdown/wikilinks/wikilinkDecorator.js'
import {
  blockDateAdapterFacet,
  type BlockDateAdapter,
} from '../blockDateAdapter.ts'
import {
  openReschedulePickerEvent,
  type OpenReschedulePickerEventDetail,
} from '../rescheduleEvents.ts'
import { dailyDateWikilinkDecorator } from '../wikilinkDateDecorator.ts'

const sourceBlock = {id: 'source-block'} as Block

const adapter: BlockDateAdapter = {
  id: 'test.adapter',
  canHandle: block => block.id === sourceBlock.id,
  getCurrentIso: async () => '2026-04-26',
  setIso: async () => true,
}

const runtime = resolveFacetRuntimeSync([
  blockDateAdapterFacet.of(adapter),
])

const ctx = (alias: string, overrides: Partial<WikilinkDisplayContext> = {}): WikilinkDisplayContext => ({
  alias,
  blockId: 'target-date-block',
  workspaceId: 'ws',
  ...overrides,
})

afterEach(() => {
  cleanup()
})

describe('dailyDateWikilinkDecorator', () => {
  it('prefixes weekday to Roam long-form aliases', () => {
    // 2026-04-26 is a Sunday.
    expect(dailyDateWikilinkDecorator.decorate(ctx('April 26th, 2026')))
      .toBe('Sun, April 26th, 2026')
  })

  it('prefixes weekday to ISO aliases', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('2026-04-26')))
      .toBe('Sun, 2026-04-26')
  })

  it('returns null for non-date aliases', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('My notes page'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('today'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('friday'))).toBeNull()
  })

  it('returns null for relative or fuzzy date expressions (not canonical)', () => {
    // parseLiteralDailyPageTitle rejects anything not in canonical form,
    // so a chrono-parseable but non-canonical alias like "April 26 2026"
    // should pass through undecorated rather than hijack the display.
    expect(dailyDateWikilinkDecorator.decorate(ctx('April 26 2026'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('next week'))).toBeNull()
  })

  it('returns null for malformed dates that look ISO-shaped', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('2026-13-01'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx(''))).toBeNull()
  })

  it('adds an inline reschedule button when the source block has a date adapter', () => {
    const decorated = dailyDateWikilinkDecorator.decorate(ctx('2026-04-26', {
      runtime,
      sourceBlock,
    }))

    expect(isWikilinkDisplayParts(decorated)).toBe(true)
    if (!isWikilinkDisplayParts(decorated)) return
    expect(decorated.content).toBe('Sun, 2026-04-26')

    const opened: OpenReschedulePickerEventDetail[] = []
    window.addEventListener(openReschedulePickerEvent, event => {
      opened.push((event as CustomEvent<OpenReschedulePickerEventDetail>).detail)
    }, {once: true})

    render(createElement(Fragment, null, decorated.before))
    fireEvent.click(screen.getByRole('button', {name: 'Reschedule date'}))

    expect(opened).toEqual([expect.objectContaining({
      blockId: 'source-block',
      workspaceId: 'ws',
    })])
  })
})
