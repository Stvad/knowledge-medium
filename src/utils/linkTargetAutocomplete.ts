import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties.js'

export interface LinkTargetAliasMatch {
  alias: string
  blockId: string
  content: string
}

export interface LinkTargetBlockMatch {
  blockId: string
  content: string
  label: string
}

export interface LinkTargetSearchResult {
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
}

export interface ProgressiveLinkTargetSearchCallbacks {
  onAliases?: (aliases: LinkTargetAliasMatch[]) => void
  onBlocks?: (blocks: LinkTargetBlockMatch[], result: LinkTargetSearchResult) => void
}

export interface LinkTargetIdCandidate {
  id: string
  label: string
  detail: string
}

export interface LinkTargetValueCandidate {
  key: string
  value: string
  label: string
  detail: string
}

export const labelForBlockData = (
  data: BlockData | null | undefined,
  fallback: string,
): string => {
  const aliases = data?.properties[aliasesProp.name]
  if (Array.isArray(aliases)) {
    const alias = aliases.find((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (alias) return alias
  }
  const content = data?.content?.trim()
  return content || fallback
}

const stringSet = (values?: Iterable<string>): Set<string> =>
  new Set(values ?? [])

const aliasMatchesFromRows = (
  rows: LinkTargetAliasMatch[],
  seenBlockIds: Set<string>,
): LinkTargetAliasMatch[] => {
  const aliases: LinkTargetAliasMatch[] = []
  for (const row of rows) {
    if (seenBlockIds.has(row.blockId)) continue
    seenBlockIds.add(row.blockId)
    aliases.push({
      alias: row.alias,
      blockId: row.blockId,
      content: row.content,
    })
  }
  return aliases
}

const blockMatchesFromRows = (
  rows: BlockData[],
  seenBlockIds: Set<string>,
): LinkTargetBlockMatch[] => {
  const blocks: LinkTargetBlockMatch[] = []
  for (const block of rows) {
    if (seenBlockIds.has(block.id)) continue
    seenBlockIds.add(block.id)
    blocks.push({
      blockId: block.id,
      content: block.content,
      label: labelForBlockData(block, block.id),
    })
  }
  return blocks
}

export const searchAliasLabels = async (
  repo: Repo,
  {
    workspaceId,
    query,
  }: {
    workspaceId: string
    query: string
  },
): Promise<string[]> => {
  if (!workspaceId) return []
  return repo.query.aliasesInWorkspace({workspaceId, filter: query.trim()}).load()
}

export const searchLinkTargets = async (
  repo: Repo,
  {
    workspaceId,
    query,
    limit,
    excludeBlockIds,
  }: {
    workspaceId: string
    query: string
    limit: number
    excludeBlockIds?: Iterable<string>
  },
): Promise<LinkTargetSearchResult> => {
  const trimmed = query.trim()
  if (!workspaceId || !trimmed) return {aliases: [], blocks: []}

  return searchLinkTargetsProgressively(repo, {
    workspaceId,
    query: trimmed,
    limit,
    excludeBlockIds,
  })
}

export const searchLinkTargetsProgressively = async (
  repo: Repo,
  {
    workspaceId,
    query,
    limit,
    excludeBlockIds,
  }: {
    workspaceId: string
    query: string
    limit: number
    excludeBlockIds?: Iterable<string>
  },
  callbacks: ProgressiveLinkTargetSearchCallbacks = {},
): Promise<LinkTargetSearchResult> => {
  const trimmed = query.trim()
  if (!workspaceId || !trimmed) return {aliases: [], blocks: []}

  const aliasRowsPromise = repo.query.aliasMatches({workspaceId, filter: trimmed, limit}).load()
  const blockRowsPromise = repo.query.searchByContent({workspaceId, query: trimmed, limit}).load()
    .then(
      rows => ({ok: true as const, rows}),
      error => ({ok: false as const, error}),
    )

  const seenBlockIds = stringSet(excludeBlockIds)
  const aliases = aliasMatchesFromRows(await aliasRowsPromise, seenBlockIds)
  callbacks.onAliases?.(aliases)

  const blockRows = await blockRowsPromise
  if (!blockRows.ok) throw blockRows.error

  const blocks = blockMatchesFromRows(blockRows.rows, seenBlockIds)
  const result = {aliases, blocks}
  callbacks.onBlocks?.(blocks, result)
  return result
}

export const searchLinkTargetIdCandidates = async (
  repo: Repo,
  args: {
    workspaceId: string
    query: string
    limit: number
    excludeIds?: Iterable<string>
  },
): Promise<LinkTargetIdCandidate[]> => {
  const matches = await searchLinkTargets(repo, {
    workspaceId: args.workspaceId,
    query: args.query,
    limit: args.limit,
    excludeBlockIds: args.excludeIds,
  })

  return [
    ...matches.aliases.map((row): LinkTargetIdCandidate => ({
      id: row.blockId,
      label: row.alias,
      detail: row.content,
    })),
    ...matches.blocks.map((block): LinkTargetIdCandidate => ({
      id: block.blockId,
      label: block.label,
      detail: block.content,
    })),
  ].slice(0, args.limit)
}

export const searchLinkTargetValueCandidates = async (
  repo: Repo,
  args: {
    workspaceId: string
    query: string
    limit: number
    excludeValues?: Iterable<string>
  },
): Promise<LinkTargetValueCandidate[]> => {
  const matches = await searchLinkTargets(repo, {
    workspaceId: args.workspaceId,
    query: args.query,
    limit: args.limit,
  })
  const seenValues = stringSet(args.excludeValues)
  const candidates: LinkTargetValueCandidate[] = []

  const pushCandidate = (candidate: LinkTargetValueCandidate) => {
    const value = candidate.value.trim()
    if (!value || seenValues.has(value)) return
    seenValues.add(value)
    candidates.push({...candidate, value})
  }

  for (const row of matches.aliases) {
    pushCandidate({
      key: `alias:${row.blockId}:${row.alias}`,
      value: row.alias,
      label: row.alias,
      detail: row.content,
    })
  }
  for (const block of matches.blocks) {
    pushCandidate({
      key: `block:${block.blockId}`,
      value: block.label,
      label: block.label,
      detail: block.content,
    })
  }

  return candidates.slice(0, args.limit)
}
