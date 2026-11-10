/** CodeMirror CompletionSource for the `@query` contributor trigger:
 *  `@name` becomes `[[name]]`, a link to the contributor's profile page
 *  (which is what an agent-dispatch watcher listens for). A bare `@` and
 *  `@@` belong to places — see `src/editor/atTrigger.ts`. */

import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { matchMentionTrigger } from '@/editor/atTrigger'
import { acceptCompletionInsert } from '@/editor/contentFlush'
import { isInsideLiteralMarkdown } from '@/editor/syntaxContext'
import { faithfulWikilinkReplacement } from '@/plugins/references/referenceParser'
import { CONTRIBUTOR_TYPE, contributorKindOf, type ContributorKind } from './schema'

const RESULT_CAP = 8

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
    const kind = contributorKindOf(profile)
    if (kind === 'automation') continue
    const name = profile.content.trim()
    if (!matchesWordPrefix(name, trimmed)) continue
    const replacement = faithfulWikilinkReplacement(name)
    if (!replacement) continue
    if (await resolveAlias(name) !== profile.id) continue
    out.push({id: profile.id, name, kind, wikilink: replacement.text})
    if (out.length >= RESULT_CAP) break
  }
  return out
}

/** `contributorMentionCandidates` over the workspace's live profiles,
 *  resolving each title the way the references processor binds
 *  `[[title]]` (`core.aliasLookup`, oldest claimant). */
export const loadContributorMentionCandidates = async (
  repo: Repo,
  workspaceId: string,
  query: string,
): Promise<ContributorMentionCandidate[]> => {
  const profiles = await repo.query.byType({workspaceId, type: CONTRIBUTOR_TYPE}).load()
  return contributorMentionCandidates(profiles, query, async alias =>
    (await repo.query.aliasLookup({workspaceId, alias}).load())?.id ?? null)
}

export const contributorMentionSource = (
  getCandidates: (query: string) => Promise<ContributorMentionCandidate[]>,
): CompletionSource =>
  async (context: CompletionContext): Promise<CompletionResult | null> => {
    const {state, pos} = context
    const line = state.doc.lineAt(pos)
    const match = matchMentionTrigger(line.text, pos - line.from)
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
        apply: (view, _completion, from, to) =>
          acceptCompletionInsert(view, {from, to, insert: candidate.wikilink}),
      })),
    }
  }
