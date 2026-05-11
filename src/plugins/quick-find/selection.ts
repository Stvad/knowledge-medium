import type {
  LinkTargetAliasMatch,
  LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.ts'

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
  dateValue: string
  currentValue: string
}

export const nextQuickFindSelection = ({
  query,
  aliases,
  blocks,
  dateValue,
  currentValue,
}: SelectionArgs): string => {
  const createValue = quickFindCreateValue(query)
  const visibleValues = [
    ...(dateValue ? [dateValue] : []),
    ...aliases.map(quickFindAliasValue),
    ...blocks.map(quickFindBlockValue),
  ]
  const hasExactAliasMatch = aliases.some(
    match => match.alias.toLowerCase() === query.toLowerCase(),
  )

  if (!dateValue && !hasExactAliasMatch) {
    visibleValues.push(createValue)
  }

  const firstVisibleValue = visibleValues[0]
  if (!firstVisibleValue) return currentValue

  return currentValue === '' || currentValue === createValue || !visibleValues.includes(currentValue)
    ? firstVisibleValue
    : currentValue
}
