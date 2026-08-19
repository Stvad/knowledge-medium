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

/** Turn a `--limit` option into the command's `limit` field.
 *
 *  Same CAC artifact as above with a different blast radius: `--limit
 *  "$UNSET"` arrives as the number 0, and every consumer downstream reads 0
 *  as a real bound — `typeof command.limit === 'number'` passes, and a
 *  `limit = 50` destructuring default is bypassed — so the query runs
 *  `LIMIT 0` and reports "nothing found" for a graph that has the answer. */
export const limitOption = (limit: string | number | undefined): {limit?: number} => {
  if (limit === undefined) return {}
  const parsed = Number(limit)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--limit expects a positive integer; got ${JSON.stringify(limit)}. An empty value `
      + '(a shell expanding an unset variable) arrives as 0, which would run the query '
      + 'with LIMIT 0. Omit the option to take the default.',
    )
  }
  return {limit: parsed}
}
