// URL hash format: #<workspaceId>/<slot1>/<slot2>/...
//
// A slot is either a bare block id or a sidebar stack:
//   #ws/a/b/c          flat horizontal panels
//   #ws/a/(s:x,b)/c    x stacked above b in the second horizontal column
//
// Ids are UUIDs (text). An empty hash means "use the user's last-active
// workspace from localStorage, falling back to the first synced workspace".
// A hash with only a workspace id (no `/`) means "restore or create the
// workspace's layout-session panel layout".
//
// Phase 2 drops support for legacy hashes (`#<blockId>` without a workspace
// id). The previous data is disposable per the workspace migration, so any
// bookmarked legacy URL won't resolve to a real block anyway.

export interface AppRoute {
  workspaceId?: string
  blockId?: string
}

export interface AppLayoutRoute {
  workspaceId?: string
  slots: LayoutSlot[]
  blockIds: string[]
}

export type LayoutSlot =
  | {kind: 'leaf'; blockId: string}
  | {kind: 'stack'; children: LayoutSlot[]}

const flattenSlots = (slots: readonly LayoutSlot[]): string[] =>
  slots.flatMap(slot => slot.kind === 'leaf' ? [slot.blockId] : flattenSlots(slot.children))

const splitHashRouteAndParams = (hash: string | undefined | null) => {
  const raw = hash ?? ''
  const trimmed = raw.startsWith('#') ? raw.slice(1) : raw
  const queryIndex = trimmed.indexOf('?')
  return {
    route: queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed,
    params: new URLSearchParams(queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : ''),
  }
}

const buildHashWithParams = (route: string, params: URLSearchParams): string => {
  const query = params.toString()
  if (!route && !query) return ''
  return `#${route}${query ? `?${query}` : ''}`
}

export const preserveHashQueryParams = (
  nextHash: string,
  currentHash: string | undefined | null,
): string => {
  const next = splitHashRouteAndParams(nextHash)
  const current = splitHashRouteAndParams(currentHash)
  const merged = new URLSearchParams(next.params)
  const nextKeys = new Set(merged.keys())

  current.params.forEach((value, key) => {
    if (!nextKeys.has(key)) merged.append(key, value)
  })

  return buildHashWithParams(next.route, merged)
}

const splitTopLevel = (input: string, separator: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '(') depth++
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === separator && depth === 0) {
      out.push(input.slice(start, index))
      start = index + 1
    }
  }
  out.push(input.slice(start))
  return out
}

const parseSlot = (raw: string): LayoutSlot | null => {
  const token = raw.trim()
  if (!token) return null
  if (token.startsWith('(s:') && token.endsWith(')')) {
    const inner = token.slice(3, -1)
    return {
      kind: 'stack',
      children: splitTopLevel(inner, ',')
        .map(parseSlot)
        .filter((slot): slot is LayoutSlot => Boolean(slot)),
    }
  }
  return {kind: 'leaf', blockId: token}
}

export const parseLayout = (hash: string | undefined | null): AppLayoutRoute => {
  if (!hash) return {slots: [], blockIds: []}
  const trimmed = splitHashRouteAndParams(hash).route
  if (!trimmed) return {slots: [], blockIds: []}

  const [workspaceId, ...slotTokens] = splitTopLevel(trimmed, '/')
  const slots = slotTokens
    .map(parseSlot)
    .filter((slot): slot is LayoutSlot => Boolean(slot))
  return {
    workspaceId: workspaceId || undefined,
    slots,
    blockIds: flattenSlots(slots),
  }
}

export const buildLayout = (workspaceId: string, blockIds: readonly string[] = []): string =>
  blockIds.length > 0 ? `#${workspaceId}/${blockIds.join('/')}` : `#${workspaceId}`

const buildLayoutSlot = (slot: LayoutSlot): string => {
  if (slot.kind === 'leaf') return slot.blockId
  return `(s:${slot.children.map(buildLayoutSlot).join(',')})`
}

export const buildLayoutFromSlots = (workspaceId: string, slots: readonly LayoutSlot[] = []): string =>
  slots.length > 0 ? `#${workspaceId}/${slots.map(buildLayoutSlot).join('/')}` : `#${workspaceId}`

export const layoutWorkspaceChanged = (
  previousHash: string | undefined | null,
  nextHash: string | undefined | null,
): boolean =>
  parseLayout(previousHash).workspaceId !== parseLayout(nextHash).workspaceId

export const parseAppHash = (hash: string | undefined | null): AppRoute => {
  const {workspaceId, blockIds} = parseLayout(hash)
  if (!workspaceId) return {}
  return {
    workspaceId,
    blockId: blockIds[0],
  }
}

export const buildAppHash = (workspaceId: string, blockId?: string): string =>
  buildLayout(workspaceId, blockId ? [blockId] : [])
