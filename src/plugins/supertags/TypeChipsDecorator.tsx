/** Block content decorator that renders a block's types as trailing
 *  `#label` chips (Tana-style supertags), each with a remove button.
 *
 *  Unlike the character-counter/geo decorators, the contribution does
 *  NOT gate on `ctx.types`: the wrap applies to every block and the
 *  component decides whether to render chips. Gating would swap the
 *  content renderer's component identity exactly when a type is added
 *  or removed — i.e. mid-edit, right as the `#` autocomplete applies —
 *  remounting the CodeMirror editor under the user's cursor. The
 *  unconditional wrapper keeps identity stable across type changes;
 *  the WeakMap cache keeps it stable across parent re-renders (same
 *  invariant as CharacterCountDecorator). */

import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import type { TypeContribution } from '@/data/api'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo'
import { typesProp } from '@/data/properties'
import { useProperty } from '@/hooks/block.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { HIDDEN_TYPE_IDS } from './typeAutocomplete'

/** Reactive read of the merged type registry. `repo.types` is replaced
 *  wholesale on every facet-bridge rebuild, so the getter is a valid
 *  useSyncExternalStore snapshot (stable reference between changes). */
const useTypesRegistry = (repo: Repo): ReadonlyMap<string, TypeContribution> =>
  useSyncExternalStore(
    onStoreChange => repo.onTypesChange(onStoreChange),
    () => repo.types,
  )

const TypeChips = ({block, typeIds}: {block: Block, typeIds: readonly string[]}) => {
  const registry = useTypesRegistry(block.repo)
  const readOnly = block.repo.isReadOnly
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1" aria-label="Block types">
      {typeIds.map(typeId => {
        const type = registry.get(typeId)
        const label = type?.label ?? typeId
        return (
          <span
            key={typeId}
            className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            title={type?.description ?? typeId}
          >
            <span className="truncate">#{label}</span>
            {!readOnly && (
              <button
                type="button"
                className="rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`Remove ${label} type`}
                onMouseDown={event => event.preventDefault()}
                onClick={event => {
                  // Removing a tag must not double as "activate the
                  // block's editor" — the content surface underneath
                  // treats bubbled clicks as edit intents.
                  event.stopPropagation()
                  void block.removeType(typeId)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        )
      })}
    </span>
  )
}

interface TypeChipsDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

const TypeChipsDecorator = ({block, Inner}: TypeChipsDecoratorProps) => {
  const [types] = useProperty(block, typesProp)
  const visible = types.filter(typeId => !HIDDEN_TYPE_IDS.has(typeId))
  return (
    <div className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <div className="min-w-0 max-w-full flex-1 basis-48">
        <Inner block={block}/>
      </div>
      {visible.length > 0 && <TypeChips block={block} typeIds={visible}/>}
    </div>
  )
}

const cache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorate: BlockContentDecorator = inner => {
  const existing = cache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = ({block}) => (
    <TypeChipsDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithTypeChips'
  cache.set(inner, Decorated)
  return Decorated
}

export const typeChipsDecoratorContribution: BlockContentDecoratorContribution = () => decorate
