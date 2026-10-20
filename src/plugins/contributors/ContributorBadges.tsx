import {useMemo, useState} from 'react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {useHandle, useHandles} from '@/hooks/block.js'
import {useAppHashInContext} from '@/context/layoutWsContext.js'
import {useOpenBlock} from '@/utils/navigation.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type {BlockRenderer} from '@/types.js'
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/dropdown-menu'
import {
  attributionCreatorsProp,
  attributionEditorsProp,
  contributorKindProp,
  contributorRoleProp,
  type ContributorKind,
} from './schema.js'

type Attribution = {creators: readonly string[]; editors: readonly string[]; workspaceId: string}
type Profile = {id: string; name: string; kind: ContributorKind; role?: string}

const readProperty = <T,>(data: BlockData, schema: {name: string; codec: {decode: (value: unknown) => T}; defaultValue: T}): T => {
  const value = data.properties[schema.name]
  return value === undefined ? schema.defaultValue : schema.codec.decode(value)
}

const useAttribution = (block: Block): Attribution | undefined => useHandle(block, {
  selector: data => data ? {
    creators: readProperty(data, attributionCreatorsProp),
    editors: readProperty(data, attributionEditorsProp),
    workspaceId: data.workspaceId,
  } : undefined,
})

const ProfileLink = ({profile, workspaceId}: {profile: Profile; workspaceId: string}) => {
  const open = useOpenBlock({blockId: profile.id, workspaceId})
  const href = useAppHashInContext(workspaceId, profile.id)
  return (
    <DropdownMenuItem asChild className="h-auto cursor-pointer items-baseline justify-between gap-3 py-1.5">
      <a href={href} onClick={open}>
        <span className="font-medium">{profile.name}</span>
        <span className="text-muted-foreground">{profile.kind}{profile.role ? ` · ${profile.role}` : ''}</span>
      </a>
    </DropdownMenuItem>
  )
}

const ContributorBadgesView = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const attribution = useAttribution(block)
  const allIds = useMemo(() => [...new Set([...(attribution?.creators ?? []), ...(attribution?.editors ?? [])])], [attribution?.creators, attribution?.editors])
  const profileBlocks = useMemo(() => allIds.map(id => block.repo.block(id)), [allIds, block.repo])
  const profileRows = useHandles(profileBlocks)
  const profiles = useMemo(() => {
    const byId = new Map<string, Profile>()
    profileRows.forEach((row, index) => {
      if (!row) return
      const id = allIds[index]
      let kind: ContributorKind = 'agent'
      let role: string | undefined
      try {
        kind = readProperty(row, contributorKindProp)
        role = readProperty(row, contributorRoleProp)
      } catch { /* An unreadable profile still gets a useful linked fallback. */ }
      byId.set(id, {
        id,
        name: row.content.trim().split('\n')[0] || `${kind} contributor`,
        kind,
        role,
      })
    })
    return byId
  }, [profileRows, allIds])

  const uniqueProfiles = (ids: readonly string[]): Profile[] =>
    [...new Map(ids.map(id => profiles.get(id)).filter((p): p is Profile => Boolean(p)).map(profile => [profile.id, profile])).values()]
  const creatorProfiles = uniqueProfiles(attribution?.creators ?? [])
  const editorProfiles = uniqueProfiles(attribution?.editors ?? [])
  const visible = [...creatorProfiles, ...editorProfiles].some(profile => profile.kind !== 'human')
  const [open, setOpen] = useState(false)
  if (!attribution || !visible) return <Inner block={block}/>

  const nonHumanCreators = [...new Map(creatorProfiles.filter(p => p.kind !== 'human').map(p => [p.id, p])).values()]
  const nonHumanEditors = [...new Map(editorProfiles.filter(p => p.kind !== 'human').map(p => [p.id, p])).values()]
  const summarize = (label: string, entries: Profile[]): string => {
    if (entries.length === 0) return ''
    const first = entries[0]
    const person = `${first.name}${first.role ? ` · ${first.role}` : ''}`
    return `${label} ${person}${entries.length > 1 ? ` +${entries.length - 1}` : ''}`
  }
  const summary = [summarize('By', nonHumanCreators), summarize('Edited by', nonHumanEditors)].filter(Boolean).join(' · ')

  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Authorship details: ${summary}`}
            onClick={event => event.stopPropagation()}
            className="mt-0.5 inline-flex h-4 max-w-56 shrink-0 select-none items-center rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{summary}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuLabel>Created by</DropdownMenuLabel>
          {creatorProfiles.length ? creatorProfiles.map(profile => (
            <ProfileLink key={`creator:${profile.id}`} profile={profile} workspaceId={attribution.workspaceId}/>
          )) : <div className="px-2 py-1.5 text-xs text-muted-foreground">No attribution</div>}
          <DropdownMenuSeparator/>
          <DropdownMenuLabel>Edited by</DropdownMenuLabel>
          {editorProfiles.length ? editorProfiles.map(profile => (
            <ProfileLink key={`editor:${profile.id}`} profile={profile} workspaceId={attribution.workspaceId}/>
          )) : <div className="px-2 py-1.5 text-xs text-muted-foreground">No attribution</div>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const decorate = cachedContentDecorator(ContributorBadgesView, 'WithContributorBadges')

export const contributorBadgesDecoratorContribution: BlockContentDecoratorContribution = () => decorate
