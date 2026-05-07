import { aliasesProp, typesProp } from '@/data/properties'
import type { RoamImportPlan } from './plan'
import { parseRoamImportReferences } from './references'
import {
  PAGE_TOKEN_RE,
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
  explodePageTokens,
} from './properties'

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

export interface RoamTypeCandidateReportSection {
  title: string
  lines: string[]
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
const MAX_LOW_CONFIDENCE_TYPE_CANDIDATES_IN_REPORT = 10
const MAX_COMMON_PROPS_IN_REPORT = 5

const isPureTokenString = (value: string): boolean => {
  if (explodePageTokens(value) !== null) return true
  const trimmed = value.trim()
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return false
  PAGE_TOKEN_RE.lastIndex = 0
  const match = PAGE_TOKEN_RE.exec(trimmed)
  return match !== null && match.index === 0 && match[0].length === trimmed.length
}

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

  if (isPureTokenString(trimmed)) {
    return uniqueNonEmpty(parseRoamImportReferences(trimmed).map(ref => ref.alias))
  }

  // Plain-string `isa::person` is a legitimate Roam spelling and is
  // imported as a semantic ref-list value. Mixed prose/SRS marker text
  // that merely contains `[[...]]` is not a type declaration; letting
  // those references through created bogus candidates like interval/factor.
  return parseRoamImportReferences(trimmed).length === 0 ? [trimmed] : []
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

const typeCandidateLine = (candidate: RoamTypeCandidate): string => {
  const nodeLabel = candidate.count === 1
    ? '1 node'
    : `${candidate.count} nodes`
  const props = candidate.commonProperties.length > 0
    ? candidate.commonProperties
      .map(prop => `${prop.name} ${prop.count}/${candidate.count} (${prop.percent}%)`)
      .join(', ')
    : 'no recurring props'
  return `[[${candidate.alias}]] -> type "${candidate.typeId}" (${nodeLabel}); common props: ${props}`
}

const highConfidenceTypeCandidate = (candidate: RoamTypeCandidate): boolean =>
  candidate.count >= 2 && (candidate.count >= 5 || candidate.commonProperties.length > 0)

const formatTypeCandidateLines = (
  candidates: ReadonlyArray<RoamTypeCandidate>,
  max: number,
): string[] => {
  const lines = candidates.slice(0, max).map(typeCandidateLine)

  if (candidates.length > max) {
    lines.push(`${candidates.length - max} more isa:: candidates omitted from this report section.`)
  }

  return lines
}

export const formatTypeCandidateReport = (
  candidates: ReadonlyArray<RoamTypeCandidate>,
): RoamTypeCandidateReportSection[] => {
  const highConfidence = candidates.filter(highConfidenceTypeCandidate)
  const lowerConfidence = candidates.filter(candidate => !highConfidenceTypeCandidate(candidate))
  const sections: RoamTypeCandidateReportSection[] = []

  if (highConfidence.length > 0) {
    sections.push({
      title: `High-confidence (${highConfidence.length})`,
      lines: formatTypeCandidateLines(highConfidence, MAX_TYPE_CANDIDATES_IN_REPORT),
    })
  }
  if (lowerConfidence.length > 0) {
    sections.push({
      title: `Lower-confidence / needs review (${lowerConfidence.length})`,
      lines: formatTypeCandidateLines(
        lowerConfidence,
        MAX_LOW_CONFIDENCE_TYPE_CANDIDATES_IN_REPORT,
      ),
    })
  }

  return sections
}
