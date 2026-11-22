import { EditorState } from '@codemirror/state'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions.js'
import { contributorMentionSource, loadContributorMentionCandidates } from './mentionAutocomplete'

export const contributorsCodeMirrorExtensions: CodeMirrorExtensionContribution = ({repo}) => {
  const source = contributorMentionSource(async query => {
    const workspaceId = repo.activeWorkspaceId
    return workspaceId ? loadContributorMentionCandidates(repo, workspaceId, query) : []
  })
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
