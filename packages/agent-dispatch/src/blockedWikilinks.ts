import type { BridgeGraph } from '@knowledge-medium/agent-cli/graph'
import type { GraphMcpWriteGuard } from '@knowledge-medium/agent-cli/mcpServer'

/** Dispatch-owned MCP policy: page aliases whose wikilinks the spawned
 *  agent write tools must refuse to create. JSON-array encoded; legacy
 *  comma-separated values are still accepted for hand-written .mcp.json use. */
export const BLOCKED_WIKILINKS_ENV = 'KM_MCP_BLOCKED_WIKILINKS'

export const encodeBlockedWikilinks = (names: string[]): string => JSON.stringify(names)

export const decodeBlockedWikilinks = (value: string | undefined): string[] => {
  const raw = (value ?? '').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((name): name is string => typeof name === 'string' && name.length > 0)
      }
    } catch {
      // fall through to the legacy form
    }
  }
  return raw.split(',').map(name => name.trim()).filter(Boolean)
}

export interface RefGuardSet {
  aliases: string[]
  ids: string[]
}

export const findBlockedRef = (content: string, guard: RefGuardSet): string | null => {
  const lower = content.normalize('NFC').toLowerCase()
  for (const alias of guard.aliases) {
    if (lower.includes(`[[${alias.normalize('NFC').toLowerCase()}]]`)) return `[[${alias}]]`
  }
  for (const id of guard.ids) {
    if (lower.includes(`((${id.toLowerCase()}))`)) return `((${id}))`
  }
  return null
}

export const findBlockedRefInProperties = (
  properties: Record<string, unknown> | undefined,
  guard: RefGuardSet,
): string | null => {
  if (!properties) return null
  const blob = JSON.stringify(properties).normalize('NFC').toLowerCase()
  const contentHit = findBlockedRef(blob, guard)
  if (contentHit) return contentHit
  for (const id of guard.ids) {
    if (blob.includes(id.toLowerCase())) return id
  }
  return null
}

const decodeStringList = (raw: unknown): string[] => {
  const keepStrings = (values: unknown[]) =>
    values.filter((entry): entry is string => typeof entry === 'string')
  if (Array.isArray(raw)) return keepStrings(raw)
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? keepStrings(parsed) : []
  } catch {
    return []
  }
}

const targetGuardSet = async (
  graph: Pick<BridgeGraph, 'resolvePageId' | 'getBlock'>,
  alias: string,
): Promise<{id: string, aliases: string[]}> => {
  const id = await graph.resolvePageId(alias)
  const block = await graph.getBlock(id)
  const decoded = decodeStringList(block?.properties?.['alias'])
  return {id, aliases: [...new Set([alias, ...decoded])]}
}

const propertiesFromJson = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

const refsFromSqlRow = (
  row: unknown,
): {content?: string, properties?: Record<string, unknown>} => {
  if (!row || typeof row !== 'object') return {}
  const {content, properties_json} = row as {content?: unknown, properties_json?: unknown}
  const properties = propertiesFromJson(properties_json)
  return {
    ...(typeof content === 'string' ? {content} : {}),
    ...(properties ? {properties} : {}),
  }
}

interface MoveSiblingRow {
  id: string
  orderKey: string
  content?: string
  properties?: Record<string, unknown>
}

const moveSiblingFromSqlRow = (row: unknown): MoveSiblingRow | null => {
  if (!row || typeof row !== 'object') return null
  const {id, order_key} = row as {id?: unknown, order_key?: unknown}
  if (typeof id !== 'string' || typeof order_key !== 'string') return null
  return {
    id,
    orderKey: order_key,
    ...refsFromSqlRow(row),
  }
}

interface DeleteGuardRow {
  id: string
  content?: string
  properties?: Record<string, unknown>
}

const deleteGuardRowFromSqlRow = (row: unknown): DeleteGuardRow | null => {
  if (!row || typeof row !== 'object') return null
  const {id} = row as {id?: unknown}
  if (typeof id !== 'string') return null
  return {id, ...refsFromSqlRow(row)}
}

export const createBlockedWikilinkWriteGuard = (
  graph: Pick<BridgeGraph, 'resolvePageId' | 'getBlock' | 'sqlAll'>,
  blockedWikilinks: string[],
): GraphMcpWriteGuard => {
  const blockedNames = blockedWikilinks.map(name => name.trim()).filter(Boolean)
  if (blockedNames.length === 0) {
    return {beforeWrite: () => {}}
  }

  const resolveGuardSet = async (): Promise<RefGuardSet> => {
    const aliases = new Set(blockedNames)
    const ids = new Set<string>()
    for (const name of blockedNames) {
      try {
        const target = await targetGuardSet(graph, name)
        ids.add(target.id)
        for (const alias of target.aliases) aliases.add(alias)
      } catch {
        // Page missing / bridge hiccup: fall back to the raw-name guard.
      }
    }
    return {aliases: [...aliases], ids: [...ids]}
  }

  const storedRefsForGuard = async (
    id: string,
  ): Promise<{content?: string, properties?: Record<string, unknown>}> => {
    const rows = await graph.sqlAll(
      'SELECT content, properties_json FROM blocks WHERE id = ? LIMIT 1',
      [id],
    )
    return refsFromSqlRow(rows[0])
  }

  const workspaceIdForMoveTarget = async (
    movedId: string,
    parentId: string | null,
  ): Promise<string | null> => {
    const targetId = parentId ?? movedId
    const rows = await graph.sqlAll(
      'SELECT workspace_id FROM blocks WHERE id = ? LIMIT 1',
      [targetId],
    )
    const row = rows[0]
    if (!row || typeof row !== 'object') return null
    const {workspace_id} = row as {workspace_id?: unknown}
    return typeof workspace_id === 'string' ? workspace_id : null
  }

  const moveTiedRewriteRowsForGuard = async (
    input: {id: string, parentId: string | null, position: {kind: 'first'} | {kind: 'last'} | {kind: 'before', siblingId: string} | {kind: 'after', siblingId: string}},
  ): Promise<MoveSiblingRow[]> => {
    const {id, parentId, position} = input
    if (position.kind !== 'before' && position.kind !== 'after') return []

    const workspaceId = await workspaceIdForMoveTarget(id, parentId)
    if (!workspaceId) return []
    const rows = parentId === null
      ? await graph.sqlAll(
        `SELECT id, content, properties_json, order_key
           FROM blocks
          WHERE workspace_id = ?
            AND parent_id IS NULL
            AND deleted = 0
            AND id <> ?
          ORDER BY order_key, id`,
        [workspaceId, id],
      )
      : await graph.sqlAll(
        `SELECT id, content, properties_json, order_key
           FROM blocks
          WHERE workspace_id = ?
            AND parent_id = ?
            AND deleted = 0
            AND id <> ?
          ORDER BY order_key, id`,
        [workspaceId, parentId, id],
      )
    const siblings = rows.flatMap(row => {
      const sibling = moveSiblingFromSqlRow(row)
      return sibling ? [sibling] : []
    })
    const anchor = siblings.findIndex(row => row.id === position.siblingId)
    if (anchor < 0) return []
    const anchorKey = siblings[anchor].orderKey

    if (position.kind === 'before') {
      const prev = anchor > 0 ? siblings[anchor - 1] : undefined
      if (!prev || prev.orderKey < anchorKey) return []
      let runEnd = anchor
      while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
        runEnd++
      }
      return siblings.slice(anchor, runEnd + 1)
    }

    const next = anchor + 1 < siblings.length ? siblings[anchor + 1] : undefined
    if (!next || anchorKey < next.orderKey) return []
    let runEnd = anchor + 1
    while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
      runEnd++
    }
    return siblings.slice(anchor + 1, runEnd + 1)
  }

  const createWriteAssertions = () => {
    let guardSetForWrite: Promise<RefGuardSet> | null = null
    const guardSet = () => {
      guardSetForWrite ??= resolveGuardSet()
      return guardSetForWrite
    }

    const assertNoBlockedRefs = async (
      content: string | undefined,
      properties?: Record<string, unknown>,
    ) => {
      if (!content && !properties) return
      const guard = await guardSet()
      const blocked =
        (content ? findBlockedRef(content, guard) : null)
        ?? findBlockedRefInProperties(properties, guard)
      if (blocked) {
        throw new Error(
          `Refusing to write "${blocked}": it references a blocked page. Refer to the page without linking it.`,
        )
      }
    }

    const assertNoBlockedRefsInStoredRow = async (id: string): Promise<void> => {
      const {content, properties} = await storedRefsForGuard(id)
      await assertNoBlockedRefs(content, properties)
    }

    const assertNoBlockedRefsInLiveDescendants = async (rootId: string): Promise<void> => {
      const childRows = await graph.sqlAll(
        `SELECT id, content, properties_json
         FROM blocks
        WHERE parent_id = ?
          AND deleted = 0
        ORDER BY order_key, id`,
        [rootId],
      )
      const stack = childRows.flatMap(row => {
        const child = deleteGuardRowFromSqlRow(row)
        return child ? [child] : []
      })
      const seen = new Set<string>()
      while (stack.length > 0) {
        const row = stack.pop()!
        if (seen.has(row.id)) continue
        seen.add(row.id)
        await assertNoBlockedRefs(row.content, row.properties)

        const grandchildRows = await graph.sqlAll(
          `SELECT id, content, properties_json
             FROM blocks
            WHERE parent_id = ?
              AND deleted = 0
            ORDER BY order_key, id`,
          [row.id],
        )
        for (const grandchildRow of grandchildRows) {
          const grandchild = deleteGuardRowFromSqlRow(grandchildRow)
          if (grandchild) stack.push(grandchild)
        }
      }
    }

    return {assertNoBlockedRefs, assertNoBlockedRefsInStoredRow, assertNoBlockedRefsInLiveDescendants}
  }

  return {
    beforeWrite: async operation => {
      const {
        assertNoBlockedRefs,
        assertNoBlockedRefsInStoredRow,
        assertNoBlockedRefsInLiveDescendants,
      } = createWriteAssertions()
      switch (operation.type) {
        case 'create_block':
        case 'update_block':
          await assertNoBlockedRefs(operation.content, operation.properties)
          return
        case 'move_block': {
          await assertNoBlockedRefsInStoredRow(operation.id)
          await assertNoBlockedRefsInLiveDescendants(operation.id)
          const tiedRewriteRows = await moveTiedRewriteRowsForGuard(operation)
          for (const row of tiedRewriteRows) {
            await assertNoBlockedRefs(row.content, row.properties)
          }
          return
        }
        case 'delete_block':
          await assertNoBlockedRefsInStoredRow(operation.id)
          await assertNoBlockedRefsInLiveDescendants(operation.id)
          return
        case 'restore_block':
          await assertNoBlockedRefsInStoredRow(operation.id)
          await assertNoBlockedRefsInLiveDescendants(operation.id)
          return
      }
    },
  }
}
