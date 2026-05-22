/**
 * Daily-notes contribution to `wikilinkDisplayDecoratorFacet`: prefixes
 * date-shaped wikilink aliases with the weekday at render time
 * ("Fri, April 26th, 2026") so date references in block content are
 * scannable without changing how they're stored. The underlying alias
 * — what the link resolver and Roam-style canonical alias depend on —
 * is untouched.
 *
 * Accepts both canonical forms via `parseLiteralDailyPageTitle`:
 *   - long: "April 26th, 2026"  → "Fri, April 26th, 2026"
 *   - ISO:  "2026-04-26"        → "Fri, 2026-04-26"
 *
 * Weekday is locale-pinned to en-US to match the rest of the daily-page
 * alias (also en-US). Display-time use only — never written to storage.
 */
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'
import { CalendarDays } from 'lucide-react'
import { createElement, type MouseEvent } from 'react'
import type {
  WikilinkDisplayContext,
  WikilinkDisplayDecorator,
  WikilinkDisplayParts,
} from '@/plugins/references/markdown/wikilinks/wikilinkDecorator.js'
import { hasAnyBlockDateAdapter } from './blockDateAdapter.ts'
import {
  openReschedulePicker,
  type ReschedulePickerAnchorRect,
} from './rescheduleEvents.ts'

const formatWeekday = (date: Date): string =>
  date.toLocaleDateString('en-US', {weekday: 'short'})

const rectFor = (element: HTMLElement): ReschedulePickerAnchorRect => {
  const rect = element.getBoundingClientRect()
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  }
}

const rescheduleButton = ({
  sourceBlock,
  workspaceId,
}: Pick<WikilinkDisplayContext, 'sourceBlock' | 'workspaceId'>) => {
  if (!sourceBlock) return null

  const open = (element: HTMLElement): void => {
    openReschedulePicker({
      blockId: sourceBlock.id,
      workspaceId,
      anchorRect: rectFor(element),
    })
  }

  return createElement(
    'button',
    {
      'aria-label': 'Reschedule date',
      className: 'mr-1 inline-flex h-4 w-4 translate-y-[2px] items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      'data-block-interaction': 'ignore',
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.stopPropagation()
        open(event.currentTarget)
      },
      onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.stopPropagation()
      },
      title: 'Reschedule date',
      type: 'button',
    },
    createElement(CalendarDays, {
      'aria-hidden': true,
      size: 13,
      strokeWidth: 2,
    }),
  )
}

export const dailyDateWikilinkDecorator: WikilinkDisplayDecorator = {
  id: 'daily-notes.date-weekday-prefix',
  decorate: ({
    alias,
    runtime,
    sourceBlock,
    workspaceId,
  }: WikilinkDisplayContext): string | WikilinkDisplayParts | null => {
    const parsed = parseLiteralDailyPageTitle(alias)
    if (!parsed) return null
    const content = `${formatWeekday(parsed.date)}, ${alias}`
    if (!runtime || !sourceBlock || !hasAnyBlockDateAdapter(runtime, sourceBlock)) {
      return content
    }
    return {
      before: rescheduleButton({sourceBlock, workspaceId}),
      content,
    }
  },
}
