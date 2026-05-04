export interface GroupedBacklinkCandidate {
  sourceId: string
  groupId: string
  groupLabel: string
  kind: 'ref' | 'root'
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
}

type GroupPriority = 'high' | 'default' | 'low'

export const FALLBACK_GROUP_ID = '__grouped_backlinks_other__'
export const FALLBACK_GROUP_LABEL = 'Other'

const DEFAULT_EXCLUSIONS = [
  /^ptr$/,
  /^otter\.ai\/transcript$/,
  /^otter\.ai$/,
  /^TODO$/,
  /^DONE$/,
  /^factor$/,
  /^interval$/,
  /^\[\[factor]]:.+/,
  /^\[\[interval]]:.+/,
  /^isa$/,
  /^repeat interval$/,
  /^make-public$/,
  /^matrix-messages$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^[A-Z][a-z]+ \d{1,2}(st|nd|rd|th), \d{4}$/,
]

const LOW_PRIORITY = [
  /^reflection$/,
  /^task$/,
  /^weekly review$/,
  /^person$/,
]

const matchesAny = (label: string, patterns: readonly RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(label))

const classify = (
  candidate: GroupedBacklinkCandidate,
  highPriorityIds: ReadonlySet<string>,
): GroupPriority => {
  if (highPriorityIds.has(candidate.groupId)) return 'high'
  if (candidate.kind === 'root' || matchesAny(candidate.groupLabel, LOW_PRIORITY)) {
    return 'low'
  }
  return 'default'
}

const labelExcluded = (label: string): boolean =>
  !label.trim() || matchesAny(label, DEFAULT_EXCLUSIONS)

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
  highPriorityIds = [],
  minGroupSize = 2,
}: {
  targetId: string
  sourceOrder: readonly string[]
  candidates: readonly GroupedBacklinkCandidate[]
  highPriorityIds?: readonly string[]
  minGroupSize?: number
}): GroupedBacklinkGroup[] => {
  const sourceSet = new Set(sourceOrder)
  const highPrioritySet = new Set(highPriorityIds)
  const groups = new Map<string, CandidateGroup>()
  for (const candidate of candidates) {
    if (
      candidate.groupId === targetId ||
      !sourceSet.has(candidate.sourceId) ||
      labelExcluded(candidate.groupLabel)
    ) {
      continue
    }
    const priority = classify(candidate, highPrioritySet)
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
    })
  }

  const consumed = new Set<string>()
  const result: GroupedBacklinkGroup[] = []

  const consumePriority = (priority: GroupPriority) => {
    const priorityGroups = Array.from(groups.values())
      .filter(group => group.priority === priority)
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
