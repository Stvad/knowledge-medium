/**
 * Friendly-name collision UI for place creation.
 *
 * `createOrFindPlace` preflights the candidate's name and returns a
 * `name-collision` instead of attempting a create the alias-uniqueness
 * trigger would roll back. This module turns that result into a choice
 * the user can actually act on:
 *
 *   - "Add location to …" — the common case: the name belongs to a
 *     plain page (the existing-place autocomplete would have surfaced
 *     a real place match before the user ever reached "create"). The
 *     page is enriched in place via `addPlaceToExistingBlock`.
 *   - "Create new" with an editable name — for when it IS a different
 *     thing that happens to share the name. The field re-validates on
 *     submit; a still-colliding name shows an inline error instead of
 *     creating anything.
 *
 * When the claimant is itself a Place (same name, different physical
 * location), enriching would overwrite its coords, so only the
 * rename-and-create path is offered.
 *
 * `createOrFindPlaceInteractive` is the entry point callers want: the
 * happy path is a plain create/find, the collision path resolves via
 * the toast, and `null` means the user cancelled.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dismissToast, showCustom } from '@/utils/toast'
import { aliasesProp } from '@/data/properties'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  addPlaceToExistingBlock,
  createOrFindPlace,
  placeMachineAlias,
  type PlaceCandidate,
  type PlaceNameCollision,
} from './createOrFindPlace'

export interface InteractivePlaceResult {
  block: Block
  /** Name the block is reachable by — what a `[[...]]` link should use.
   *  For the enrich path this is the colliding name itself (the
   *  existing block's alias); for a renamed create it's the new name. */
  linkName: string
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

/** Best link-name for a block: first human alias, else content, else
 *  the caller's fallback. Mirrors the autocomplete's display logic. */
const linkNameOf = (block: Block, fallback: string): string => {
  const data = block.peek()
  if (!data) return fallback
  const raw = data.properties[aliasesProp.name]
  const aliases = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  const friendly = aliases.find(a => !a.startsWith('place:') && !a.startsWith('geo:'))
  return friendly ?? (data.content || fallback)
}

interface PlaceNameCollisionToastProps {
  repo: Repo
  workspaceId: string
  candidate: PlaceCandidate
  collision: PlaceNameCollision
  onSettle: (result: InteractivePlaceResult | null) => void
}

const PlaceNameCollisionToast = ({
  repo,
  workspaceId,
  candidate,
  collision,
  onSettle,
}: PlaceNameCollisionToastProps) => {
  const [name, setName] = useState(collision.name)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const existingLabel = collision.existing.content.trim() === ''
    ? collision.name
    : collision.existing.content

  const addToExisting = async () => {
    if (pending) return
    setPending(true)
    try {
      const block = await addPlaceToExistingBlock(repo, collision.existing.id, candidate)
      onSettle({block, linkName: collision.name})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the location')
      setPending(false)
    }
  }

  const createWithName = async () => {
    if (pending) return
    const trimmed = name.trim()
    if (trimmed === '') {
      setError('Enter a name for the new place.')
      return
    }
    setPending(true)
    try {
      const result = await createOrFindPlace(repo, workspaceId, {...candidate, name: trimmed})
      if (result.kind === 'name-collision') {
        setError(`"${trimmed}" is taken too — try another name.`)
        setPending(false)
        return
      }
      onSettle({block: result.block, linkName: linkNameOf(result.block, trimmed)})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the place')
      setPending(false)
    }
  }

  const message = collision.existing.isPlace
    ? `A different place is already named "${truncate(collision.name, 40)}". Pick another name for this one.`
    : `"${truncate(collision.name, 40)}" is already the name of another page.`

  return (
    <div className="flex w-full min-w-[300px] flex-col gap-2 rounded-md border border-border bg-background px-4 py-3 text-sm shadow-lg">
      <span className="text-foreground">{message}</span>
      {error !== null && <span className="text-destructive">{error}</span>}
      {!collision.existing.isPlace && (
        <Button
          variant="default"
          size="sm"
          disabled={pending}
          onClick={() => { void addToExisting() }}
        >
          {`Add location to "${truncate(existingLabel, 30)}"`}
        </Button>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={name}
          disabled={pending}
          className="h-8"
          aria-label="Name for the new place"
          onChange={e => { setName(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') void createWithName() }}
        />
        <Button
          variant={collision.existing.isPlace ? 'default' : 'secondary'}
          size="sm"
          disabled={pending}
          onClick={() => { void createWithName() }}
        >
          {pending ? 'Working…' : 'Create new'}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => onSettle(null)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Surface the collision toast and resolve with the user's choice —
 *  the enriched/created block, or `null` on cancel. The toast stays
 *  up until acted on (it's a decision, not a notification). */
export const promptPlaceNameCollision = (
  repo: Repo,
  workspaceId: string,
  candidate: PlaceCandidate,
  collision: PlaceNameCollision,
): Promise<InteractivePlaceResult | null> =>
  new Promise(resolve => {
    let settled = false
    const toastId = showCustom(
      () => (
        <PlaceNameCollisionToast
          repo={repo}
          workspaceId={workspaceId}
          candidate={candidate}
          collision={collision}
          onSettle={result => {
            if (settled) return
            settled = true
            dismissToast(toastId)
            resolve(result)
          }}
        />
      ),
      {duration: Number.POSITIVE_INFINITY},
    )
  })

/** `createOrFindPlace` + collision resolution UI. Returns `null` when
 *  the user dismissed the collision prompt without choosing. */
export const createOrFindPlaceInteractive = async (
  repo: Repo,
  workspaceId: string,
  candidate: PlaceCandidate,
): Promise<InteractivePlaceResult | null> => {
  const result = await createOrFindPlace(repo, workspaceId, candidate)
  if (result.kind === 'ok') {
    const fallback = candidate.name.trim() || placeMachineAlias(candidate)
    return {block: result.block, linkName: linkNameOf(result.block, fallback)}
  }
  return promptPlaceNameCollision(repo, workspaceId, candidate, result)
}
