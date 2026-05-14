import {
  parseOutermostReferences,
  type ParsedReference,
  renderWikilink,
} from '@/plugins/references/referenceParser.ts'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.ts'
import { formatRoamDate } from '@/utils/dailyPage.ts'
import {
  ActionConfig,
  ActionContextTypes,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.ts'
import { addDaysIso } from './dailyNotes.ts'

export const DATE_SHIFT_FORWARD_DAY_ACTION_ID = 'date.shift.forward.day'
export const DATE_SHIFT_BACKWARD_DAY_ACTION_ID = 'date.shift.backward.day'
export const DATE_SHIFT_FORWARD_WEEK_ACTION_ID = 'date.shift.forward.week'
export const DATE_SHIFT_BACKWARD_WEEK_ACTION_ID = 'date.shift.backward.week'

type DateShiftActionContext =
  | typeof ActionContextTypes.NORMAL_MODE
  | typeof ActionContextTypes.EDIT_MODE_CM

interface DateReferenceMatch {
  ref: ParsedReference
  iso: string
  style: 'iso' | 'long'
}

const isoToLocalDate = (iso: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new Error(`Invalid ISO date: ${iso}`)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const dateReferenceMatches = (content: string): DateReferenceMatch[] =>
  parseOutermostReferences(content).flatMap(ref => {
    const parsed = parseLiteralDailyPageTitle(ref.alias)
    if (!parsed) return []
    return [{
      ref,
      iso: parsed.iso,
      style: ref.alias.trim() === parsed.iso ? 'iso' : 'long',
    }]
  })

export const shiftSingleDateReferenceContent = (
  content: string,
  days: number,
): string | null => {
  const matches = dateReferenceMatches(content)
  if (matches.length !== 1) return null

  const [{ref, iso, style}] = matches
  const nextIso = addDaysIso(iso, days)
  const nextAlias = style === 'iso'
    ? nextIso
    : formatRoamDate(isoToLocalDate(nextIso))

  return content.slice(0, ref.startIndex) +
    renderWikilink(nextAlias) +
    content.slice(ref.endIndex)
}

const contentForDependencies = (
  deps: BlockShortcutDependencies | CodeMirrorEditModeDependencies,
): string | null => {
  if ('editorView' in deps) return deps.editorView.state.doc.toString()
  const data = deps.block.peek()
  return data ? data.content : null
}

export const canShiftSingleDateReference = (
  deps: BlockShortcutDependencies | CodeMirrorEditModeDependencies,
  days: number,
): boolean => {
  const content = contentForDependencies(deps)
  return content !== null && shiftSingleDateReferenceContent(content, days) !== null
}

export const shiftSingleDateReferenceForBlock = async (
  deps: BlockShortcutDependencies | CodeMirrorEditModeDependencies,
  days: number,
): Promise<boolean> => {
  const {block} = deps
  if (block.repo.isReadOnly) return false

  const data = block.peek() ?? await block.load()
  if (!data) return false

  const sourceContent = 'editorView' in deps
    ? deps.editorView.state.doc.toString()
    : data.content
  const nextContent = shiftSingleDateReferenceContent(sourceContent, days)
  if (nextContent === null) return false

  if ('editorView' in deps) {
    deps.editorView.dispatch({
      changes: {
        from: 0,
        to: deps.editorView.state.doc.length,
        insert: nextContent,
      },
    })
  }

  await block.setContent(nextContent)
  return true
}

const createDateReferenceShiftAction = <T extends DateShiftActionContext>(
  context: T,
  id: string,
  description: string,
  days: number,
  keys: readonly string[],
): ActionConfig<T> => ({
  id,
  description,
  context,
  handler: (async (deps) => {
    await shiftSingleDateReferenceForBlock(deps, days)
  }) as ActionConfig<T>['handler'],
  canRun: ((deps) => canShiftSingleDateReference(deps, days)) as ActionConfig<T>['canRun'],
  defaultBinding: {
    keys: [...keys],
    eventOptions: {preventDefault: true},
  },
})

const actionSpecs = [
  {
    id: DATE_SHIFT_FORWARD_DAY_ACTION_ID,
    description: 'Shift date reference forward one day',
    days: 1,
    keys: ['ctrl+alt+up', 'ctrl+alt+h'],
  },
  {
    id: DATE_SHIFT_BACKWARD_DAY_ACTION_ID,
    description: 'Shift date reference backward one day',
    days: -1,
    keys: ['ctrl+alt+down', 'ctrl+alt+k'],
  },
  {
    id: DATE_SHIFT_FORWARD_WEEK_ACTION_ID,
    description: 'Shift date reference forward one week',
    days: 7,
    keys: ['ctrl+shift+up', 'ctrl+shift+h'],
  },
  {
    id: DATE_SHIFT_BACKWARD_WEEK_ACTION_ID,
    description: 'Shift date reference backward one week',
    days: -7,
    keys: ['ctrl+shift+down', 'ctrl+shift+k'],
  },
] as const

export const dateReferenceShiftActions: readonly ActionConfig[] = [
  ...actionSpecs.map(spec =>
    createDateReferenceShiftAction(
      ActionContextTypes.NORMAL_MODE,
      spec.id,
      spec.description,
      spec.days,
      spec.keys,
    ),
  ),
  ...actionSpecs.map(spec =>
    createDateReferenceShiftAction(
      ActionContextTypes.EDIT_MODE_CM,
      spec.id,
      `${spec.description} (Edit Mode)`,
      spec.days,
      spec.keys,
    ),
  ),
]
