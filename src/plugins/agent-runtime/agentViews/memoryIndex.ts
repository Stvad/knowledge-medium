import { AGENT_VIEW_DEFAULTS, toDisplayJson, type MemoryIndexView } from '@knowledge-medium/agent-cli/protocol'
import type { Repo } from '@/data/repo'
import { isWholeContentReference } from '@/data/referenceBlock'
import { indexChildren, loadBlocks, visibleChildCounts } from './context.ts'
import { embeddedRefs } from './refs.ts'
import { loadRoot, plural } from './shared.ts'
import { clipLine } from './text.ts'

const NOTE_LIMIT = 100

interface Host {
  id: string
  content: string
}

const indexId = (id: string): string =>
  /^[a-z0-9_-]+$/iu.test(id) ? `^${id}` : `id=${toDisplayJson(id)}`

/** Batch the live, same-workspace destinations for one collection. */
const targetsByHost = async (repo: Repo, workspaceId: string, hosts: Host[], rootId: string) => {
  const embeds = []
  for await (const embed of embeddedRefs(repo, workspaceId, hosts)) embeds.push(embed)
  const byHost = new Map<string, Array<{block: Host, kind: 'embed' | 'page-embed'}>>()
  if (!embeds.length) return byHost
  const rows = await repo.db.getAll<Host>(
    `SELECT b.id, CASE WHEN instr(b.content, '!') > 0 THEN b.content ELSE '' END AS content
       FROM json_each(?) j CROSS JOIN blocks b ON b.id = j.value
      WHERE b.workspace_id = ? AND b.deleted = 0`,
    [JSON.stringify([...new Set(embeds.map(embed => embed.id))]), workspaceId],
  )
  const live = new Map(rows.map(row => [row.id, row]))
  for (const {id, hostId, kind} of embeds) {
    const block = live.get(id)
    if (!block || (id === rootId && kind === 'embed')) continue
    const targets = byHost.get(hostId) ?? []
    targets.push({block, kind})
    byHost.set(hostId, targets)
  }
  return byHost
}

export const buildMemoryIndex = async (repo: Repo, workspaceId: string, ref: string): Promise<MemoryIndexView> => {
  const {root} = await loadRoot(repo, ref, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  const sharedRoots = new Set<string>()
  const visitedPages = new Set<string>([root.id])
  // A note keeps its first position and takes shared editing rules if any path embeds it.
  const entries = new Map<string, boolean>()
  const collect = async (container: Host, shared: boolean): Promise<void> => {
    const hosts = [container, ...await indexChildren(repo, workspaceId, container.id)]
    const byHost = await targetsByHost(repo, workspaceId, hosts, root.id)
    const hostCounts = await visibleChildCounts(repo, [...byHost.keys()], workspaceId)
    for (const host of hosts) {
      const targets = byHost.get(host.id) ?? []
      const wrapper = targets.length > 0 && isWholeContentReference(host.content) && !hostCounts.get(host.id)
      if (host.id !== container.id && !wrapper) entries.set(host.id, shared || entries.get(host.id) === true)
      for (const {block, kind} of targets) {
        if (block.id !== root.id) sharedRoots.add(block.id)
        if (kind === 'embed') entries.set(block.id, true)
        else if (!visitedPages.has(block.id)) {
          visitedPages.add(block.id)
          await collect(block, true)
        }
      }
    }
  }
  await collect(root, false)

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
    return `- ${entries.get(note.id) ? '[shared] ' : ''}${summary}${suffix} ${indexId(note.id)}`
  })
  const omitted = ids.slice(NOTE_LIMIT)
  if (omitted.length) {
    lines.push(`Showing ${notes.length} of ${ids.length} notes. Omitted note IDs: ${omitted.map(id => `${entries.get(id) ? '[shared] ' : ''}${indexId(id)}`).join(', ')}`)
  }
  return {text: lines.join('\n') || '(no memory notes)', sharedRoots: [...sharedRoots]}
}
