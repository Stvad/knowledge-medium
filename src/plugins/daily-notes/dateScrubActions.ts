import { Block } from '@/data/block'
import type { AppExtension } from '@/extensions/facet.js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import {
  finishDateKeyboardScrub,
  requestDateKeyboardScrubStart,
  updateDateKeyboardScrubByDays,
} from './dateScrubGesture.ts'

export const DATE_SCRUB_CONTEXT = 'daily-notes.date-scrub'

export const START_DATE_SCRUB_ACTION_ID = 'daily-notes.date-scrub.start'
export const EDIT_MODE_START_DATE_SCRUB_ACTION_ID = 'edit.cm.daily-notes.date-scrub.start'
export const DATE_SCRUB_FORWARD_DAY_ACTION_ID = 'daily-notes.date-scrub.forward-day'
export const DATE_SCRUB_BACKWARD_DAY_ACTION_ID = 'daily-notes.date-scrub.backward-day'
export const DATE_SCRUB_FORWARD_WEEK_ACTION_ID = 'daily-notes.date-scrub.forward-week'
export const DATE_SCRUB_BACKWARD_WEEK_ACTION_ID = 'daily-notes.date-scrub.backward-week'
export const DATE_SCRUB_COMMIT_ACTION_ID = 'daily-notes.date-scrub.commit'
export const DATE_SCRUB_CANCEL_ACTION_ID = 'daily-notes.date-scrub.cancel'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' &&
  deps !== null &&
  'uiStateBlock' in deps &&
  deps.uiStateBlock instanceof Block

export const dateScrubActionContext: ActionContextConfig<typeof DATE_SCRUB_CONTEXT> = {
  type: DATE_SCRUB_CONTEXT,
  displayName: 'Date Scrub',
  exclusive: true,
  defaultEventOptions: {
    preventDefault: true,
    stopPropagation: true,
  },
  validateDependencies: isBaseShortcutDependencies,
}

const startDateScrub = (): void => {
  requestDateKeyboardScrubStart()
}

export const dateScrubStartActions: readonly ActionConfig[] = [
  {
    id: START_DATE_SCRUB_ACTION_ID,
    description: 'Start date scrub mode',
    context: ActionContextTypes.NORMAL_MODE,
    handler: startDateScrub,
    defaultBinding: {
      keys: 'ctrl+shift+d',
      eventOptions: {preventDefault: true},
    },
  },
  {
    id: EDIT_MODE_START_DATE_SCRUB_ACTION_ID,
    description: 'Start date scrub mode (CodeMirror)',
    context: ActionContextTypes.EDIT_MODE_CM,
    handler: startDateScrub,
    defaultBinding: {
      keys: 'ctrl+shift+d',
      eventOptions: {preventDefault: true},
    },
  },
]

export const dateScrubModeActions: readonly ActionConfig<typeof DATE_SCRUB_CONTEXT>[] = [
  {
    id: DATE_SCRUB_FORWARD_DAY_ACTION_ID,
    description: 'Date scrub: move forward one day',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      updateDateKeyboardScrubByDays(1)
    },
    defaultBinding: {keys: ['up', 'h']},
  },
  {
    id: DATE_SCRUB_BACKWARD_DAY_ACTION_ID,
    description: 'Date scrub: move backward one day',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      updateDateKeyboardScrubByDays(-1)
    },
    defaultBinding: {keys: ['down', 'k']},
  },
  {
    id: DATE_SCRUB_FORWARD_WEEK_ACTION_ID,
    description: 'Date scrub: move forward one week',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      updateDateKeyboardScrubByDays(7)
    },
    defaultBinding: {keys: ['right', 'l']},
  },
  {
    id: DATE_SCRUB_BACKWARD_WEEK_ACTION_ID,
    description: 'Date scrub: move backward one week',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      updateDateKeyboardScrubByDays(-7)
    },
    defaultBinding: {keys: ['left', 'j']},
  },
  {
    id: DATE_SCRUB_COMMIT_ACTION_ID,
    description: 'Date scrub: commit',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      finishDateKeyboardScrub(true)
    },
    defaultBinding: {keys: 'enter'},
  },
  {
    id: DATE_SCRUB_CANCEL_ACTION_ID,
    description: 'Date scrub: cancel',
    context: DATE_SCRUB_CONTEXT,
    handler: () => {
      finishDateKeyboardScrub(false)
    },
    defaultBinding: {keys: 'escape'},
  },
]

export const dateScrubActionsExtension: AppExtension = [
  actionContextsFacet.of(dateScrubActionContext, {source: 'daily-notes'}),
  ...dateScrubStartActions.map(action => actionsFacet.of(action, {source: 'daily-notes'})),
  ...dateScrubModeActions.map(action => actionsFacet.of(action, {source: 'daily-notes'})),
]
