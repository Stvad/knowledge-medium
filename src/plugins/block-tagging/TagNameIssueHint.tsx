import { MAX_ALIAS_LENGTH } from '@/plugins/references/referenceParser'
import type { TagNameIssue } from './config.ts'

/** Renders nothing for `null` and for 'empty': an empty draft is not an error
 *  worth showing, only a reason the submit control stays disabled. */
export const TagNameIssueHint = ({issue}: {issue: TagNameIssue | null}) => {
  switch (issue) {
    case 'delimiters':
      return (
        <p className="text-xs text-destructive">
          Tag names can&apos;t contain <code>[[</code> or <code>]]</code>.
        </p>
      )
    case 'unmatched-bracket':
      return (
        <p className="text-xs text-destructive">
          Tag names can&apos;t end in an unmatched <code>]</code>.
        </p>
      )
    case 'too-long':
      return (
        <p className="text-xs text-destructive">
          Tag names must be under {MAX_ALIAS_LENGTH} characters.
        </p>
      )
    default:
      return null
  }
}
