import type {
  LinkTargetAliasMatch,
  LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'

export const quickFindAliasValue = (match: LinkTargetAliasMatch) =>
  `page:${match.blockId}:${match.alias}`

export const quickFindBlockValue = (match: LinkTargetBlockMatch) =>
  `block:${match.blockId}`

export const quickFindCreateValue = (query: string) => `create:${query}`

export const quickFindDateValue = (iso: string) => `date:${iso}`

export type QuickFindOpenTarget = 'jump' | 'stack'

interface QuickFindModifierState {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

interface QuickFindClickModifierState {
  shiftKey?: boolean
}

export const quickFindOpenTargetFromModifiers = ({
  shiftKey,
  metaKey,
  ctrlKey,
}: QuickFindModifierState): QuickFindOpenTarget =>
  shiftKey || metaKey || ctrlKey ? 'stack' : 'jump'

export const quickFindOpenTargetFromClickModifiers = ({
  shiftKey,
}: QuickFindClickModifierState): QuickFindOpenTarget =>
  shiftKey ? 'stack' : 'jump'

export type QuickFindSelectionAction =
  | {kind: 'create-page'; alias: string; target: QuickFindOpenTarget}
  | {kind: 'open-date'; iso: string; target: QuickFindOpenTarget}
  | {kind: 'open-block'; blockId: string; target: QuickFindOpenTarget}

export const quickFindSelectionAction = (
  selectedValue: string,
  target: QuickFindOpenTarget,
): QuickFindSelectionAction | null => {
  const colonIdx = selectedValue.indexOf(':')
  if (colonIdx === -1) return null
  const kind = selectedValue.slice(0, colonIdx)
  const payload = selectedValue.slice(colonIdx + 1)

  if (kind === 'create') return {kind: 'create-page', alias: payload, target}
  if (kind === 'date') return {kind: 'open-date', iso: payload, target}

  const blockId = payload.split(':')[0]
  return blockId ? {kind: 'open-block', blockId, target} : null
}

interface SelectionArgs {
  query: string
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
  dateValues: string[]
  currentValue: string
}

export const nextQuickFindSelection = ({
  query,
  aliases,
  blocks,
  dateValues,
  currentValue,
}: SelectionArgs): string => {
  const createValue = quickFindCreateValue(query)
  const visibleValues = [
    ...dateValues,
    ...aliases.map(quickFindAliasValue),
    ...blocks.map(quickFindBlockValue),
  ]
  const hasExactAliasMatch = aliases.some(
    match => match.alias.toLowerCase() === query.toLowerCase(),
  )

  if (dateValues.length === 0 && !hasExactAliasMatch) {
    visibleValues.push(createValue)
  }

  const firstVisibleValue = visibleValues[0]
  if (!firstVisibleValue) return currentValue

  return currentValue === '' || currentValue === createValue || !visibleValues.includes(currentValue)
    ? firstVisibleValue
    : currentValue
}
