/** Normalization of CLI option values into wire-command fields.
 *
 *  Lives here rather than in `cli.ts` because that module self-executes
 *  (`main()` runs on import), so nothing in it can be unit-tested. */

/** Turn a `--workspace` option into the command's `workspaceId` field.
 *
 *  Tests PRESENCE, not truthiness. CAC parses an empty option value —
 *  `--workspace ""`, which is what a shell produces for `--workspace "$UNSET"`
 *  — into the NUMBER 0: falsy, but present. A truthiness check therefore drops
 *  the assertion before it is ever sent, and the command silently answers
 *  about the ACTIVE workspace instead of the one the caller named, which is
 *  precisely what passing `--workspace` is meant to prevent.
 *
 *  The 0 is normalized back to an empty string so the command layer's
 *  purpose-built rejection is what the user sees, rather than a confusing
 *  "cannot resolve workspace 0". */
export const workspaceAssertion = (
  workspace: string | number | undefined,
): {workspaceId?: string} => {
  if (workspace === undefined) return {}
  return {workspaceId: workspace === 0 ? '' : String(workspace)}
}
