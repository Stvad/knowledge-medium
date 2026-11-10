/** CodeMirror CompletionSource for the `@` contributor trigger: `@name`
 *  becomes `[[name]]`, a link to the contributor's profile page (which is
 *  what an agent-dispatch watcher listens for). `@@` belongs to places. */

import { EditorSelection } from '@codemirror/state'
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { BlockData } from '@/data/api'
import { AT_DROPDOWN_SECTIONS } from '@/editor/atDropdownSections'
import { flushEditorContent } from '@/editor/contentFlush'
import { isInsideLiteralMarkdown } from '@/editor/syntaxContext'
import { matchCharTrigger, type TriggerMatch } from '@/editor/triggerMatch'
import { faithfulWikilinkReplacement } from '@/plugins/references/referenceParser'
import { contributorKindOf, type ContributorKind } from './schema'

const RESULT_CAP = 8

export const matchContributorTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@', {doubled: 'reject'})

export interface ContributorMentionCandidate {
  id: string
  name: string
  kind: ContributorKind
  /** `[[name]]`, verified to parse back to exactly `name`. */
  wikilink: string
}

const matchesWordPrefix = (name: string, query: string): boolean => {
  const lower = name.toLowerCase()
  return lower.startsWith(query) || lower.split(/\s+/).some(word => word.startsWith(query))
}

/** The profiles `@query` offers, in input order. A profile is offered
 *  only when the link the pick inserts reaches it: its title must render
 *  as a faithful `[[title]]`, and `resolveAlias` (the id `[[title]]`
 *  binds to) must return the profile's own id — a title another page
 *  claims, including a co-claim sync let through, would link there
 *  instead. Automation contributors are not addressable. Matching is
 *  word-prefix, not fuzzy, so `@co` meant for a café does not select
 *  `Cobalt`. */
export const contributorMentionCandidates = async (
  profiles: readonly BlockData[],
  query: string,
  resolveAlias: (alias: string) => Promise<string | null>,
): Promise<ContributorMentionCandidate[]> => {
  const trimmed = query.trim().toLowerCase()
  const out: ContributorMentionCandidate[] = []
  for (const profile of profiles) {
    if (profile.deleted) continue
    const kind = contributorKindOf(profile)
    if (kind === 'automation') continue
    const name = profile.content.trim()
    if (trimmed.length > 0 && !matchesWordPrefix(name, trimmed)) continue
    const replacement = faithfulWikilinkReplacement(name)
    if (!replacement) continue
    if (await resolveAlias(name) !== profile.id) continue
    out.push({id: profile.id, name, kind, wikilink: replacement.text})
    if (out.length >= RESULT_CAP) break
  }
  return out
}

export const contributorMentionSource = (
  getCandidates: (query: string) => Promise<ContributorMentionCandidate[]>,
): CompletionSource =>
  async (context: CompletionContext): Promise<CompletionResult | null> => {
    const {state, pos} = context
    const line = state.doc.lineAt(pos)
    const match = matchContributorTrigger(line.text, pos - line.from)
    if (!match) return null
    // `@decorator` in code, `user@host` in a URL: Enter would replace it.
    if (isInsideLiteralMarkdown(state, pos)) return null

    const candidates = await getCandidates(match.query)
    if (candidates.length === 0) return null
    return {
      from: line.from + match.from,
      to: pos,
      filter: false,
      options: candidates.map(candidate => ({
        label: candidate.name,
        detail: candidate.kind,
        type: 'class',
        section: AT_DROPDOWN_SECTIONS.contributors,
        apply: (view, _completion, from, to) => {
          const insert = candidate.wikilink
          view.dispatch({
            changes: {from, to, insert},
            selection: EditorSelection.cursor(from + insert.length),
          })
          flushEditorContent(view)
        },
      })),
    }
  }
