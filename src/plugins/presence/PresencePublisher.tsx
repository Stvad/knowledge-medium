/**
 * Publishes the LOCAL user's selection / focus / editor caret to the
 * presence channel. Mounted once per panel via `panelMountsFacet` (so it
 * gets the panel's UI-state `block`), but only the ACTIVE panel publishes —
 * one client tracks one selection at a time, and the active panel is the one
 * the user is actually driving. Renders nothing.
 */
import { useEffect } from 'react'
import type { Block } from '@/data/block.js'
import { useHandle } from '@/hooks/block.js'
import { useIsActivePanel } from '@/data/globalState.js'
import {
  editorSelection,
  focusedBlockLocationFromProperties,
  selectionStateProp,
} from '@/data/properties.js'
import { presenceClient } from './presenceClient.js'
import type { LocalPresence } from './types.js'

const buildLocal = (properties: Record<string, unknown> | undefined): LocalPresence => {
  const selRaw = properties?.[selectionStateProp.name]
  const selection = selRaw === undefined
    ? selectionStateProp.defaultValue
    : selectionStateProp.codec.decode(selRaw)

  const focusedBlockId = focusedBlockLocationFromProperties(properties)?.blockId ?? null

  const edRaw = properties?.[editorSelection.name]
  const ed = edRaw === undefined ? undefined : editorSelection.codec.decode(edRaw)
  // Only surface the caret for the block the user is actually on — a stale
  // `editorSelection` left over from a different block would otherwise paint
  // a ghost caret for peers.
  const editor = ed && ed.blockId === focusedBlockId
    ? { blockId: ed.blockId, start: ed.start ?? null, end: ed.end ?? ed.start ?? null }
    : null

  return {
    selectedBlockIds: selection.selectedBlockIds,
    anchorBlockId: selection.anchorBlockId,
    focusedBlockId,
    editor,
  }
}

export function PresencePublisher({ block }: { block: Block }) {
  const active = useIsActivePanel(block)
  // `useHandle` structurally dedups the selected value, so `local`'s identity
  // is stable until the published state actually changes — the effect below
  // doesn't re-fire on unrelated UI-state churn.
  const local = useHandle(block, { selector: doc => buildLocal(doc?.properties) })

  useEffect(() => {
    if (!active) return
    presenceClient.updateLocal(local)
  }, [active, local])

  return null
}
