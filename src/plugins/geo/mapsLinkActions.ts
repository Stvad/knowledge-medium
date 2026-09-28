/** "Convert Google Maps link to place" — on the focused block, and on the
 *  block being edited (where the live editor holds the text). */

import type { EditorView } from '@codemirror/view'
import { MapPin } from 'lucide-react'
import type { Block } from '@/data/block'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { showError, showInfo } from '@/utils/toast'
import { convertMapsLinksInBlock } from './convertMapsLinks'
import { expandShortMapsLink } from './expandShortMapsLink'
import { createGooglePlacesClient, resolveApiKey } from './googlePlacesClient'
import { findGoogleMapsLinks } from './googleMapsLink'
import { resolveMapsLink } from './resolveMapsLink'

const resolveLink = (url: string) => {
  const apiKey = resolveApiKey()
  return resolveMapsLink(url, {
    client: apiKey ? createGooglePlacesClient({apiKey}) : null,
    expandShortLink: expandShortMapsLink,
  })
}

const hasMapsLink = (text: string | undefined): boolean =>
  text !== undefined && findGoogleMapsLinks(text).length > 0

const convert = async (block: Block, view?: EditorView): Promise<void> => {
  // Defence in depth — the tx refuses the write anyway; this skips the
  // short-link expansion and billed Places calls that would precede it.
  if (block.repo.isReadOnly) return
  const result = await convertMapsLinksInBlock({repo: block.repo, blockId: block.id, view}, resolveLink)
  if (result.failures.length > 0) {
    showError(result.failures.join('\n'))
  } else if (result.converted === 0) {
    showInfo('No Google Maps link to convert in this block.')
  }
}

const DESCRIPTION = 'Convert Google Maps link to place'

export const convertMapsLinkAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'geo.convert_maps_link',
  description: DESCRIPTION,
  context: ActionContextTypes.NORMAL_MODE,
  icon: MapPin,
  isVisible: ({block}) => hasMapsLink(block.peek()?.content),
  handler: ({block}) => convert(block),
}

export const editModeConvertMapsLinkAction: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: 'geo.convert_maps_link.edit_mode',
  description: DESCRIPTION,
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: MapPin,
  isVisible: ({editorView}) => hasMapsLink(editorView.state.doc.toString()),
  handler: ({block, editorView}) => convert(block, editorView),
}
