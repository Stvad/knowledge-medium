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
  isEditingProp,
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

  const editingRaw = properties?.[isEditingProp.name]
  const editing = editingRaw === undefined
    ? isEditingProp.defaultValue
    : isEditingProp.codec.decode(editingRaw)

  const edRaw = properties?.[editorSelection.name]
  const ed = edRaw === undefined ? undefined : editorSelection.codec.decode(edRaw)
  // Only surface the caret while the user is actually editing the focused
  // block. Gating on edit mode (not just focus) clears the caret on
  // Escape/blur — otherwise `editorSelection` lingers and peers see a ghost
  // caret until focus moves to another block.
  const editor = editing && ed && ed.blockId === focusedBlockId
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
