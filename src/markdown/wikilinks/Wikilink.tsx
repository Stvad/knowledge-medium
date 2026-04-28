import { MouseEvent } from 'react'
import { useQuery } from '@powersync/react'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { buildAppHash } from '@/utils/routing'

const SELECT_BLOCK_ID_BY_ALIAS_SQL = `
  SELECT blocks.id AS id
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND alias.value = ?
  ORDER BY blocks.create_time
  LIMIT 1
`

export function Wikilink({alias}: {alias: string}) {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const {panelId} = useBlockContext()

  const {data} = useQuery<{id: string}>(
    SELECT_BLOCK_ID_BY_ALIAS_SQL,
    [workspaceId ?? '', alias],
  )
  const blockId = data[0]?.id

  if (!workspaceId) return <span className="wikilink wikilink-broken">{alias}</span>

  const href = blockId ? buildAppHash(workspaceId, blockId) : '#'
  const className = blockId ? 'wikilink' : 'wikilink wikilink-broken'

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation()
    if (!blockId) {
      e.preventDefault()
      return
    }
    if (e.shiftKey) {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('open-panel', {
        detail: {blockId, sourcePanelId: panelId},
      }))
    }
  }

  return (
    <a href={href} className={className} data-alias={alias} onClick={onClick}>
      {alias}
    </a>
  )
}
