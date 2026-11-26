import {useMemo, useState} from 'react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {decodeRowProperty, safeDecodeRowProperty} from '@/data/rowProperty'
import {useHandle} from '@/hooks/block.js'
import {useMinuteClock} from '@/hooks/useMinuteClock.js'
import {useAppHashInContext} from '@/context/layoutWsContext.js'
import {formatAbsoluteDateTime, formatRelativeTime} from '@/utils/relativeTime.js'
import {useOpenBlock} from '@/utils/navigation.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
  type BlockGutterItem,
  type BlockGutterItemContribution,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import type {BlockRenderer} from '@/types.js'
import {GUTTER_PILL_CLASS} from '@/components/GutterPill.js'
import {GutterTextBelowHeader, useGutterHeader} from '@/components/renderer/BlockGutter.js'
import {FilePlus2, PencilLine} from 'lucide-react'
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/dropdown-menu'
import {
  attributionCreatorsProp,
  attributionEditorsProp,
  contributorKindOf,
  contributorPictureProp,
  contributorRoleProp,
  type ContributorKind,
} from './schema.js'
import {ProfilePicture} from './ProfilePicture'
import {useCommentAuthor} from './useCommentAuthor'
import {CONTRIBUTOR_PROFILES_BY_IDS_QUERY} from './queries.js'

type Attribution = {creators: readonly string[]; editors: readonly string[]; workspaceId: string}
type Profile = {id: string; name: string; kind: ContributorKind; role?: string}

const useAttribution = (block: Block): Attribution | undefined => useHandle(block, {
  selector: data => data ? {
    creators: decodeRowProperty(data, attributionCreatorsProp),
    editors: decodeRowProperty(data, attributionEditorsProp),
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

const contributorKindForDisplay = (row: BlockData): ContributorKind => {
  try { return contributorKindOf(row) } catch { return 'agent' }
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
      const kind = contributorKindForDisplay(row)
      const role = safeDecodeRowProperty(row, contributorRoleProp)
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

const ContributorBadgeItem: BlockRenderer = ({block}) => {
  const {attribution, profiles} = useContributorProfiles(block)

  const uniqueProfiles = (ids: readonly string[]): Profile[] =>
    [...new Map(ids.map(id => profiles.get(id)).filter((p): p is Profile => Boolean(p)).map(profile => [profile.id, profile])).values()]
  const creatorProfiles = uniqueProfiles(attribution?.creators ?? [])
  const editorProfiles = uniqueProfiles(attribution?.editors ?? [])
  const visible = [...creatorProfiles, ...editorProfiles].some(profile => profile.kind !== 'human')
  const [open, setOpen] = useState(false)
  if (!attribution || !visible) return null

  const creatorIds = new Set(creatorProfiles.map(profile => profile.id))
  const nonHumanCreators = creatorProfiles.filter(p => p.kind !== 'human')
  const nonHumanEditors = editorProfiles.filter(p => p.kind !== 'human' && !creatorIds.has(p.id))
  const summarize = (label: string, entries: Profile[]): string => {
    if (entries.length === 0) return ''
    return `${label} ${entries.map(profile => profile.name).join(', ')}`
  }
  const summary = [summarize('By', nonHumanCreators), summarize('Edited by', nonHumanEditors)].filter(Boolean).join(' · ')
  const primary = nonHumanCreators[0] ?? nonHumanEditors[0]
  const otherCount = nonHumanCreators.length + nonHumanEditors.length - 1
  const PrimaryIcon = nonHumanCreators.length > 0 ? FilePlus2 : PencilLine

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Authorship details: ${summary}`}
          title={summary}
          onClick={event => event.stopPropagation()}
          className={`${GUTTER_PILL_CLASS} max-w-28 gap-1 bg-muted px-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          <PrimaryIcon aria-hidden="true" className="h-3 w-3 shrink-0"/>
          <span className="min-w-0 truncate">{primary.name}</span>
          {otherCount > 0 && <span className="shrink-0">+{otherCount}</span>}
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
  )
}

/** A surface that wants every block's author shown, humans included (a comment
 *  card), sets this to its scope root's id in its `NestedBlockContextProvider`
 *  overrides. Card mode covers that root and the blocks under it, and stops at
 *  any nested surface inside the card, which resets the scope root. */
export const CONTRIBUTOR_CARD_MODE_KEY = 'contributors.cardMode'

/** The id of the one block in a card that is its header, not a contribution,
 *  and gets no author line. */
export const CONTRIBUTOR_CARD_HEADER_KEY = 'contributors.cardHeader'

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/u)
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : ''
  return (first + last).toLocaleUpperCase()
}

const ContributorCardView = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const author = useCommentAuthor(block)
  const workspaceId = author?.workspaceId ?? ''
  const profile = useHandle(block.repo.query[CONTRIBUTOR_PROFILES_BY_IDS_QUERY]({
    workspaceId, ids: author?.id ? [author.id] : [],
  }), {selector: rows => {
    const row = rows?.[0]
    // Explicit creators retain their provenance after deletion. An implicit
    // user page only becomes a link once there is a live page in this workspace.
    if (!row || (row.deleted && !author?.explicit)) return null
    return {
      name: row.content.trim().split('\n')[0],
      kind: author?.explicit ? contributorKindForDisplay(row) : 'human',
      pictureId: safeDecodeRowProperty(row, contributorPictureProp),
    }
  }})
  const linkedId = author?.explicit || profile ? author?.id : undefined
  const open = useOpenBlock({blockId: linkedId ?? '', workspaceId})
  const href = useAppHashInContext(workspaceId, linkedId ?? '')
  const now = useMinuteClock()
  const gutterHeader = useGutterHeader(block)
  if (!author) return <Inner block={block}/>
  const name = profile?.name ||
    (author.explicit ? 'Contributor' : author.id ? author.createdBy : 'System')
  const label = author.isSelf ? 'You' : name
  const kind = profile?.kind
  const nonHuman = kind && kind !== 'human'
  const pictureId = profile?.pictureId
  const identity = (
    <>
      <span
        data-author-stamp="" aria-hidden="true"
        className={`relative inline-grid size-5 shrink-0 place-items-center overflow-hidden bg-muted text-[10px] font-semibold leading-none text-muted-foreground empty:hidden ${nonHuman ? 'rounded' : 'rounded-full'}`}
      >
        {!author.isSelf && initialsOf(name)}
        {pictureId && <ProfilePicture picture={block.repo.block(pictureId)} workspaceId={workspaceId}/>}
      </span>
      <span className={linkedId ? 'truncate underline underline-offset-2' : 'truncate'}>{label}</span>
    </>
  )
  const byline = 'inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground'
  return (
    <div data-comment-author={author.isSelf ? 'self' : 'other'} className="w-full">
      <div {...gutterHeader} className="flex flex-wrap items-center gap-x-1 text-xs leading-5 text-muted-foreground">
        {linkedId
          ? <a href={href} onClick={open} title={name} className={`${byline} no-underline`}>{identity}</a>
          : <span className={byline}>{identity}</span>}
        {nonHuman && <span>· {kind}</span>}
        <span title={formatAbsoluteDateTime(author.createdAt)}>· {formatRelativeTime(author.createdAt, now)}</span>
      </div>
      <GutterTextBelowHeader>
        <Inner block={block}/>
      </GutterTextBelowHeader>
    </div>
  )
}

const decorateCard = cachedContentDecorator(ContributorCardView, 'WithContributorCard')
const badgeItem: BlockGutterItem = {corner: 'top-right', component: ContributorBadgeItem}

const inCardBody = ({block, blockContext}: BlockResolveContext): boolean => {
  const root = blockContext?.[CONTRIBUTOR_CARD_MODE_KEY]
  return typeof root === 'string' && root === blockContext?.scopeRootId &&
    block.id !== blockContext[CONTRIBUTOR_CARD_HEADER_KEY]
}

/** In a card body the author line replaces the badge. */
export const contributorCardDecoratorContribution: BlockContentDecoratorContribution = ctx =>
  inCardBody(ctx) ? decorateCard : null

export const contributorBadgeItemContribution: BlockGutterItemContribution = ctx =>
  inCardBody(ctx) ? null : badgeItem
