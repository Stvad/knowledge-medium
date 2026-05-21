import { aliasesProp, typesProp } from '@/data/properties'
import type { RoamImportPlan } from './plan'
import { parseRoamImportReferences } from './references'
import {
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
  parsePageTokenList,
} from './properties'

export interface RoamTypeCandidateProperty {
  name: string
  count: number
  percent: number
}

export interface RoamTypeCandidate {
  alias: string
  /** Deterministic block id the alias resolves to via the import's
   *  seat-materialization pass (the `aliasIdMap` populated in
   *  `resolveAliases`). The block-id IS the type id under the
   *  user-defined-types design (block-id = type-id; see
   *  `docs/user-defined-types/design.html`). `null` when the alias
   *  appeared in an `isa::` value but has no resolvable target — e.g.
   *  a tag that doesn't match any imported page or live block. */
  targetBlockId: string | null
  count: number
  commonProperties: RoamTypeCandidateProperty[]
}

export interface RoamTypeCandidateReportSection {
  title: string
  lines: string[]
}

interface TypeCandidateAccumulator {
  alias: string
  targetBlockId: string | null
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
  return parsePageTokenList(value) !== null
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
  aliasIdMap: ReadonlyMap<string, string>,
  properties: Record<string, unknown>,
) => {
  const aliases = collectIsaAliases(properties[ROAM_ISA_PROP])
  if (aliases.length === 0) return
  const props = reportablePropertyNames(properties)

  for (const alias of aliases) {
    const targetBlockId = aliasIdMap.get(alias) ?? null
    // With block-id-as-type-id, a candidate whose target block is
    // already registered as a type means the user already promoted
    // this page — skip the suggestion.
    if (targetBlockId !== null && registeredTypes.has(targetBlockId)) continue

    let group = groups.get(alias)
    if (!group) {
      group = {alias, targetBlockId, count: 0, propCounts: new Map()}
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
  aliasIdMap: ReadonlyMap<string, string>,
): RoamTypeCandidate[] => {
  const groups = new Map<string, TypeCandidateAccumulator>()

  for (const page of plan.pages) {
    const properties = page.data?.properties ?? page.promotedFromChildren
    addTypeCandidateSource(groups, registeredTypes, aliasIdMap, properties)
  }
  for (const desc of plan.descendants) {
    addTypeCandidateSource(groups, registeredTypes, aliasIdMap, desc.data.properties)
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
        targetBlockId: group.targetBlockId,
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
  // Show the alias as the human label; the resolved block-id is
  // metadata (in parens, after the node count) so the report stays
  // readable and the id is still visible for debugging / spawn-promote
  // call sites that need it.
  const idLabel = candidate.targetBlockId ?? 'no live target'
  return `[[${candidate.alias}]] (${idLabel}) — ${nodeLabel}; common props: ${props}`
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
