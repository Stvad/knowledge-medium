import { EditorState } from '@codemirror/state'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions.js'
import { CONTRIBUTOR_TYPE } from './schema'
import { contributorMentionCandidates, contributorMentionSource } from './mentionAutocomplete'

export const contributorsCodeMirrorExtensions: CodeMirrorExtensionContribution = ({repo}) => {
  const source = contributorMentionSource(async query => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return []
    const profiles = await repo.query.byType({workspaceId, type: CONTRIBUTOR_TYPE}).load()
    return contributorMentionCandidates(profiles, query, async alias =>
      (await repo.query.aliasLookup({workspaceId, alias}).load())?.id ?? null)
  })
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
