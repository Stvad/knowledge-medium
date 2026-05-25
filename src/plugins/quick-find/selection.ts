import { blockLinkClickIntent } from '@/utils/navigation.js'
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

/** Where a QuickFind selection ends up:
 *  - `jump`: navigator default — main on desktop, active on mobile.
 *  - `stack`: append to the Roam-style sidebar stack alongside the current panel.
 *  - `new-panel`: insert as a new top-level panel row.
 *  Cmd/Ctrl on keyboard maps to `stack` as a Mac-friendly affordance
 *  (no native browser default to fall through to for an Enter chord). */
export type QuickFindOpenTarget = 'jump' | 'stack' | 'new-panel'

interface QuickFindModifierState {
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

interface QuickFindClickModifierState {
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  button?: number
}

export const quickFindOpenTargetFromModifiers = ({
  shiftKey,
  altKey,
  metaKey,
  ctrlKey,
}: QuickFindModifierState): QuickFindOpenTarget => {
  if (shiftKey && altKey) return 'new-panel'
  if (shiftKey || metaKey || ctrlKey) return 'stack'
  return 'jump'
}

export const quickFindOpenTargetFromClickModifiers = ({
  shiftKey = false,
  altKey = false,
  metaKey = false,
  ctrlKey = false,
  button = 0,
}: QuickFindClickModifierState): QuickFindOpenTarget => {
  const intent = blockLinkClickIntent({shiftKey, altKey, metaKey, ctrlKey, button})
  if (intent === 'new-panel') return 'new-panel'
  if (intent === 'sidebar-stack') return 'stack'
  return 'jump'
}

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
