import {useMemo, useState} from 'react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {useHandle} from '@/hooks/block.js'
import {useMinuteClock} from '@/hooks/useMinuteClock.js'
import {useAppHashInContext} from '@/context/layoutWsContext.js'
import {useUserPage} from '@/data/globalState.js'
import {formatAbsoluteDateTime, formatRelativeTime} from '@/utils/relativeTime.js'
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
  contributorKindOf,
  contributorRoleProp,
  type ContributorKind,
} from './schema.js'
import {CONTRIBUTOR_PROFILES_BY_IDS_QUERY} from './queries.js'

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

const useContributorProfiles = (block: Block): {attribution: Attribution | undefined; profiles: Map<string, Profile>} => {
  const attribution = useAttribution(block)
  const allIds = useMemo(() => [...new Set([...(attribution?.creators ?? []), ...(attribution?.editors ?? [])])], [attribution?.creators, attribution?.editors])
  const profileRows = useHandle(
    block.repo.query[CONTRIBUTOR_PROFILES_BY_IDS_QUERY]({
      workspaceId: attribution?.workspaceId ?? '',
      ids: allIds,
    }),
    {selector: rows => rows ?? []},
  )
  const profiles = useMemo(() => {
    const byId = new Map<string, Profile>()
    profileRows.forEach(row => {
      const id = row.id
      let kind: ContributorKind = 'agent'
      let role: string | undefined
      try { kind = contributorKindOf(row) } catch { /* An unreadable profile still gets a useful linked fallback. */ }
      try { role = readProperty(row, contributorRoleProp) } catch { /* A role is optional display metadata. */ }
      byId.set(id, {
        id,
        name: row.content.trim().split('\n')[0] || `${kind} contributor`,
        kind,
        role,
      })
    })
    return byId
  }, [profileRows])
  return {attribution, profiles}
}

const ContributorBadgesView = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const {attribution, profiles} = useContributorProfiles(block)

  const uniqueProfiles = (ids: readonly string[]): Profile[] =>
    [...new Map(ids.map(id => profiles.get(id)).filter((p): p is Profile => Boolean(p)).map(profile => [profile.id, profile])).values()]
  const creatorProfiles = uniqueProfiles(attribution?.creators ?? [])
  const editorProfiles = uniqueProfiles(attribution?.editors ?? [])
  const visible = [...creatorProfiles, ...editorProfiles].some(profile => profile.kind !== 'human')
  const [open, setOpen] = useState(false)
  if (!attribution || !visible) return <Inner block={block}/>

  const creatorIds = new Set(creatorProfiles.map(profile => profile.id))
  const nonHumanCreators = [...new Map(creatorProfiles.filter(p => p.kind !== 'human').map(p => [p.id, p])).values()]
  const nonHumanEditors = [...new Map(editorProfiles.filter(p => p.kind !== 'human' && !creatorIds.has(p.id)).map(p => [p.id, p])).values()]
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

/** A surface that wants every block's author shown, humans included — a
 *  comment card — sets this in its `NestedBlockContextProvider` overrides. */
export const CONTRIBUTOR_CARD_MODE_KEY = 'contributors.cardMode'

/** The author line of a card: the first recorded creator, which every agent
 *  write has, else the `created_by` user, because human-only writes record no
 *  attribution. `created_by` alone would be wrong for agents: bridge and MCP
 *  writes run in the tab and stamp its human user. */
const ContributorCardView = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const {attribution, profiles} = useContributorProfiles(block)
  const meta = useHandle(block, {
    selector: data => data ? {createdBy: data.createdBy, createdAt: data.createdAt, workspaceId: data.workspaceId} : undefined,
  })
  const userPage = useUserPage(meta?.createdBy ?? '', meta?.workspaceId)
  const now = useMinuteClock()
  const creator = attribution?.creators.map(id => profiles.get(id)).find((p): p is Profile => Boolean(p))
  const authorId = creator?.id ?? userPage.blockId
  const authorName = creator?.name ?? userPage.name
  const open = useOpenBlock({blockId: authorId ?? '', workspaceId: meta?.workspaceId ?? ''})
  const href = useAppHashInContext(meta?.workspaceId ?? '', authorId ?? '')
  if (!meta) return <Inner block={block}/>
  return (
    <div className="w-full">
      <div className="flex items-baseline gap-1 text-xs leading-5 text-muted-foreground">
        {authorId
          ? <a href={href} onClick={open} className="font-medium text-foreground hover:underline">{authorName}</a>
          : <span className="font-medium text-foreground">{authorName}</span>}
        {creator && creator.kind !== 'human' && <span>· {creator.kind}</span>}
        <span title={formatAbsoluteDateTime(meta.createdAt)}>· {formatRelativeTime(meta.createdAt, now)}</span>
      </div>
      <Inner block={block}/>
    </div>
  )
}

const decorate = cachedContentDecorator(ContributorBadgesView, 'WithContributorBadges')
const decorateCard = cachedContentDecorator(ContributorCardView, 'WithContributorCard')

export const contributorBadgesDecoratorContribution: BlockContentDecoratorContribution = ctx =>
  ctx.blockContext?.[CONTRIBUTOR_CARD_MODE_KEY] === true ? decorateCard : decorate
