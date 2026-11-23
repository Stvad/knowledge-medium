import { AGENT_VIEW_DEFAULTS, type MemoryIndexView } from '@knowledge-medium/agent-cli/protocol'
import type { Repo } from '@/data/repo'
import { isWholeContentReference } from '@/data/referenceBlock'
import { indexChildren, loadBlocks, visibleChildCounts } from './context.ts'
import { embeddedRefs } from './refs.ts'
import { loadRoot, plural } from './shared.ts'
import { clipLine, oneLine } from './text.ts'

const NOTE_LIMIT = 100

const groupById = <T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}

export const buildMemoryIndex = async (repo: Repo, workspaceId: string, ref: string): Promise<MemoryIndexView> => {
  const {root} = await loadRoot(repo, ref, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  const local = await indexChildren(repo, workspaceId, [root.id], true)
  const hosts = [root, ...local]
  const embeds = []
  for await (const embed of embeddedRefs(repo, workspaceId, hosts)) embeds.push(embed)
  const targetIds = [...new Set(embeds.map(embed => embed.id))]
  const live = await repo.db.getAll<{id: string}>(
    `SELECT b.id FROM json_each(?) j CROSS JOIN blocks b ON b.id = j.value
      WHERE b.workspace_id = ? AND b.deleted = 0 AND b.id != ?`,
    [JSON.stringify(targetIds), workspaceId, root.id],
  )
  const sharedRoots = live.map(row => row.id)
  const shared = new Set(sharedRoots)
  const resolved = embeds.filter(embed => shared.has(embed.id))
  const byHost = groupById(resolved, embed => embed.hostId)
  const pageIds = new Set(resolved.filter(embed => embed.kind === 'page-embed').map(embed => embed.id))
  const [children, hostCounts] = await Promise.all([
    indexChildren(repo, workspaceId, [...pageIds]),
    visibleChildCounts(repo, [...byHost.keys()], workspaceId),
  ])
  const byPage = groupById(children, child => child.parentId)

  // A block reached both locally and through an embed appears once, in its
  // first position, with shared editing rules wherever it was encountered.
  const entries = new Map<string, boolean>()
  for (const host of hosts) {
    const targets = byHost.get(host.id) ?? []
    const wrapper = targets.length > 0 && isWholeContentReference(host.content) && !hostCounts.get(host.id)
    if (host.id !== root.id && !wrapper && !entries.has(host.id)) entries.set(host.id, false)
    for (const target of targets) {
      if (target.kind === 'page-embed') {
        for (const child of byPage.get(target.id) ?? []) entries.set(child.id, true)
      } else {
        entries.set(target.id, true)
      }
    }
  }

  const ids = [...entries.keys()]
  const shown = ids.slice(0, NOTE_LIMIT)
  const [notes, counts] = await Promise.all([
    loadBlocks(repo, shown, {workspaceId}),
    visibleChildCounts(repo, shown, workspaceId),
  ])
  const lines = notes.map(note => {
    const count = counts.get(note.id) ?? 0
    const suffix = count ? ` (+${plural(count, 'child', 'children')})` : ''
    const summary = clipLine(note.content, AGENT_VIEW_DEFAULTS.lineChars).text || '(empty)'
    return `- ${entries.get(note.id) ? '[shared] ' : ''}${summary}${suffix} ^${oneLine(note.id)}`
  })
  const omitted = ids.slice(NOTE_LIMIT)
  if (omitted.length) {
    lines.push(`Showing ${notes.length} of ${ids.length} notes. Omitted note IDs: ${omitted.map(id => `${entries.get(id) ? '[shared] ' : ''}^${oneLine(id)}`).join(', ')}`)
  }
  return {text: lines.join('\n') || '(no memory notes)', sharedRoots}
}
