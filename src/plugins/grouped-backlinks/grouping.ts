import {
  EMPTY_GROUPED_BACKLINKS_CONFIG,
  normalizeGroupedBacklinksConfig,
  type GroupedBacklinksConfig,
} from './config.ts'

export interface GroupedBacklinkCandidate {
  sourceId: string
  groupId: string
  groupLabel: string
  kind: 'ref' | 'root' | 'field'
}

export interface GroupedBacklinkGroup {
  groupId: string
  label: string
  sourceIds: string[]
  fallback: boolean
}

interface CandidateGroup {
  groupId: string
  label: string
  sourceIds: Set<string>
  priority: GroupPriority
  kind: GroupedBacklinkCandidate['kind']
}

type GroupPriority = 'high' | 'default' | 'low'

export const FALLBACK_GROUP_ID = '__grouped_backlinks_other__'
export const FALLBACK_GROUP_LABEL = 'Other'

interface GroupingMatcher {
  highPriorityTags: ReadonlySet<string>
  lowPriorityTags: ReadonlySet<string>
  excludedTags: ReadonlySet<string>
  excludedPatterns: readonly RegExp[]
}

const toSet = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map(value => value.trim()).filter(Boolean))

const toRegExp = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

const buildMatcher = (config: GroupedBacklinksConfig): GroupingMatcher => ({
  highPriorityTags: toSet(config.highPriorityTags),
  lowPriorityTags: toSet(config.lowPriorityTags),
  excludedTags: toSet(config.excludedTags),
  excludedPatterns: config.excludedPatterns
    .map(toRegExp)
    .filter((pattern): pattern is RegExp => pattern !== null),
})

const matchesAnyPattern = (label: string, patterns: readonly RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(label))

const classify = (
  candidate: GroupedBacklinkCandidate,
  matcher: GroupingMatcher,
): GroupPriority => {
  if (candidate.kind === 'field') return 'high'
  if (matcher.highPriorityTags.has(candidate.groupLabel)) return 'high'
  if (candidate.kind === 'root' || matcher.lowPriorityTags.has(candidate.groupLabel)) {
    return 'low'
  }
  return 'default'
}

const labelExcluded = (label: string, matcher: GroupingMatcher): boolean =>
  !label.trim() ||
  matcher.excludedTags.has(label) ||
  matchesAnyPattern(label, matcher.excludedPatterns)

const priorityRank = (priority: GroupPriority): number => {
  switch (priority) {
    case 'high': return 3
    case 'default': return 2
    case 'low': return 1
  }
}

const orderedMembers = (
  group: CandidateGroup,
  sourceOrder: readonly string[],
  consumed: ReadonlySet<string>,
): string[] => sourceOrder.filter(id => group.sourceIds.has(id) && !consumed.has(id))

const pickLargestGroup = (
  groups: readonly CandidateGroup[],
  sourceOrder: readonly string[],
  consumed: ReadonlySet<string>,
  minSize: number,
): { group: CandidateGroup; members: string[] } | null => {
  let best: { group: CandidateGroup; members: string[] } | null = null
  for (const group of groups) {
    const members = orderedMembers(group, sourceOrder, consumed)
    if (members.length < minSize) continue
    if (!best || members.length > best.members.length) {
      best = {group, members}
    }
  }
  return best
}

export const buildGroupedBacklinks = ({
  targetId,
  sourceOrder,
  candidates,
  groupingConfig = EMPTY_GROUPED_BACKLINKS_CONFIG,
  minGroupSize = 2,
}: {
  targetId: string
  sourceOrder: readonly string[]
  candidates: readonly GroupedBacklinkCandidate[]
  groupingConfig?: GroupedBacklinksConfig
  minGroupSize?: number
}): GroupedBacklinkGroup[] => {
  const sourceSet = new Set(sourceOrder)
  const matcher = buildMatcher(normalizeGroupedBacklinksConfig(groupingConfig))
  const groups = new Map<string, CandidateGroup>()
  for (const candidate of candidates) {
    if (
      candidate.groupId === targetId ||
      !sourceSet.has(candidate.sourceId) ||
      labelExcluded(candidate.groupLabel, matcher)
    ) {
      continue
    }
    const priority = classify(candidate, matcher)
    const existing = groups.get(candidate.groupId)
    if (existing) {
      existing.sourceIds.add(candidate.sourceId)
      if (priorityRank(priority) > priorityRank(existing.priority)) {
        existing.priority = priority
      }
      continue
    }
    groups.set(candidate.groupId, {
      groupId: candidate.groupId,
      label: candidate.groupLabel,
      sourceIds: new Set([candidate.sourceId]),
      priority,
      kind: candidate.kind,
    })
  }

  const consumed = new Set<string>()
  const result: GroupedBacklinkGroup[] = []

  const fieldConsumed = new Set<string>()
  const fieldGroups = Array.from(groups.values())
    .filter(group => group.kind === 'field')
    .sort((a, b) => a.label.localeCompare(b.label))
  for (const group of fieldGroups) {
    const members = orderedMembers(group, sourceOrder, new Set())
    if (members.length === 0) continue
    result.push({
      groupId: group.groupId,
      label: group.label,
      sourceIds: members,
      fallback: false,
    })
    for (const id of members) fieldConsumed.add(id)
  }
  for (const id of fieldConsumed) consumed.add(id)

  const consumePriority = (priority: GroupPriority) => {
    const priorityGroups = Array.from(groups.values())
      .filter(group => group.priority === priority && group.kind !== 'field')
    while (priorityGroups.length > 0) {
      const picked = pickLargestGroup(priorityGroups, sourceOrder, consumed, minGroupSize)
      if (!picked) return
      result.push({
        groupId: picked.group.groupId,
        label: picked.group.label,
        sourceIds: picked.members,
        fallback: false,
      })
      for (const id of picked.members) consumed.add(id)
      const idx = priorityGroups.indexOf(picked.group)
      if (idx >= 0) priorityGroups.splice(idx, 1)
    }
  }

  consumePriority('high')
  consumePriority('default')
  consumePriority('low')

  const fallbackIds = sourceOrder.filter(id => !consumed.has(id))
  if (fallbackIds.length > 0) {
    result.push({
      groupId: FALLBACK_GROUP_ID,
      label: FALLBACK_GROUP_LABEL,
      sourceIds: fallbackIds,
      fallback: true,
    })
  }

  return result
}
