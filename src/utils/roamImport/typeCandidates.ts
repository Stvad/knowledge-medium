import { aliasesProp, typesProp } from '@/data/properties'
import type { RoamImportPlan } from './plan'
import { parseRoamImportReferences } from './references'
import { ROAM_ISA_PROP, ROAM_PAGE_ALIAS_PROP } from './properties'

export interface RoamTypeCandidateProperty {
  name: string
  count: number
  percent: number
}

export interface RoamTypeCandidate {
  alias: string
  typeId: string
  count: number
  commonProperties: RoamTypeCandidateProperty[]
}

interface TypeCandidateAccumulator {
  alias: string
  typeId: string
  count: number
  propCounts: Map<string, number>
}

const TYPE_CANDIDATE_EXCLUDED_PROPERTIES = new Set([
  aliasesProp.name,
  typesProp.name,
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
])

const MAX_TYPE_CANDIDATES_IN_REPORT = 20
const MAX_COMMON_PROPS_IN_REPORT = 5

const typeIdFromIsaAlias = (alias: string): string => {
  const slug = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || alias.trim()
}

const uniqueNonEmpty = (values: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const collectIsaAliases = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return uniqueNonEmpty(value.flatMap(collectIsaAliases))
  }
  if (typeof value !== 'string') return []

  const trimmed = value.trim()
  if (trimmed.length === 0) return []

  const parsed = parseRoamImportReferences(trimmed).map(ref => ref.alias)
  if (parsed.length > 0) return uniqueNonEmpty(parsed)

  const unwrapped = /^\[\[(.+)\]\]$/.exec(trimmed)?.[1]?.trim()
  return [unwrapped ?? trimmed]
}

const reportablePropertyNames = (properties: Record<string, unknown>): string[] =>
  Object.keys(properties)
    .filter(name =>
      !TYPE_CANDIDATE_EXCLUDED_PROPERTIES.has(name) &&
      properties[name] !== undefined,
    )

const addTypeCandidateSource = (
  groups: Map<string, TypeCandidateAccumulator>,
  registeredTypes: ReadonlyMap<string, unknown>,
  properties: Record<string, unknown>,
) => {
  const aliases = collectIsaAliases(properties[ROAM_ISA_PROP])
  if (aliases.length === 0) return
  const props = reportablePropertyNames(properties)

  for (const alias of aliases) {
    const typeId = typeIdFromIsaAlias(alias)
    if (registeredTypes.has(typeId) || registeredTypes.has(alias)) continue

    let group = groups.get(alias)
    if (!group) {
      group = {alias, typeId, count: 0, propCounts: new Map()}
      groups.set(alias, group)
    }
    group.count += 1
    for (const prop of props) {
      group.propCounts.set(prop, (group.propCounts.get(prop) ?? 0) + 1)
    }
  }
}

export const collectTypeCandidates = (
  plan: RoamImportPlan,
  registeredTypes: ReadonlyMap<string, unknown>,
): RoamTypeCandidate[] => {
  const groups = new Map<string, TypeCandidateAccumulator>()

  for (const page of plan.pages) {
    const properties = page.data?.properties ?? page.promotedFromChildren
    addTypeCandidateSource(groups, registeredTypes, properties)
  }
  for (const desc of plan.descendants) {
    addTypeCandidateSource(groups, registeredTypes, desc.data.properties)
  }

  return [...groups.values()]
    .map(group => {
      const minCommonCount = group.count === 1
        ? 1
        : Math.max(2, Math.ceil(group.count * 0.15))
      const commonProperties = [...group.propCounts.entries()]
        .filter(([, count]) => count >= minCommonCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_COMMON_PROPS_IN_REPORT)
        .map(([name, count]) => ({
          name,
          count,
          percent: Math.round((count / group.count) * 100),
        }))
      return {
        alias: group.alias,
        typeId: group.typeId,
        count: group.count,
        commonProperties,
      }
    })
    .sort((a, b) => b.count - a.count || a.alias.localeCompare(b.alias))
}

export const formatTypeCandidateReport = (
  candidates: ReadonlyArray<RoamTypeCandidate>,
): string[] => {
  const lines = candidates.slice(0, MAX_TYPE_CANDIDATES_IN_REPORT).map(candidate => {
    const nodeLabel = candidate.count === 1
      ? '1 node'
      : `${candidate.count} nodes`
    const props = candidate.commonProperties.length > 0
      ? candidate.commonProperties
        .map(prop => `${prop.name} ${prop.count}/${candidate.count} (${prop.percent}%)`)
        .join(', ')
      : 'no recurring props'
    return `[[${candidate.alias}]] -> type "${candidate.typeId}" (${nodeLabel}); common props: ${props}`
  })

  if (candidates.length > MAX_TYPE_CANDIDATES_IN_REPORT) {
    lines.push(`${candidates.length - MAX_TYPE_CANDIDATES_IN_REPORT} more isa:: candidates omitted from this report.`)
  }

  return lines
}
