import type { Block } from '@/data/block'
import { useHandle, useWorkspaceId } from '@/hooks/block'
import { storedIsoDay } from '@/utils/dailyPage'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete'
import { ReferenceLink } from './ReferenceLink'

export function CompactReferenceLink({owner, targetId}: {owner: Block; targetId: string}) {
  const workspaceId = useWorkspaceId(owner)
  const target = owner.repo.block(targetId)
  const label = useHandle(target, {selector: data => data?.workspaceId === workspaceId
    ? data.content.trim() || labelForBlockData(data, 'Untitled block')
    : null})
  if (label) return <span className="block truncate"><ReferenceLink block={target}>{label}</ReferenceLink></span>

  // Some older date references store the literal date in place of a block ID.
  const literal = storedIsoDay(targetId) ? targetId : undefined
  return <span className="block truncate text-muted-foreground" title={literal}>{literal ?? 'Unavailable reference'}</span>
}
