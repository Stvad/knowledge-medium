/**
 * The `rich-paste` plugin: pasting from web pages, Google Docs and chat
 * answers reads the clipboard's HTML, so headings, lists, links, emphasis,
 * tables and code survive, with content nested under its headings.
 * Disable it and paste falls back to the browser's plain text.
 */
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { richPasteDecisionContribution } from './pasteDecision.js'

export const richPastePlugin: AppExtension = systemToggle({
  id: 'system:rich-paste',
  name: 'Rich paste',
  description: 'Pasting from web pages and docs keeps headings, lists, links, tables and formatting, nesting content under its headings.',
}).of([richPasteDecisionContribution])
