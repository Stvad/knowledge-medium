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
