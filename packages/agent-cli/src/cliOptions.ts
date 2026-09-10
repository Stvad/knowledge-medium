/* Normalization of CLI option values into wire-command fields.
 *
 * Lives here rather than in `cli.ts` because that module self-executes
 * (`main()` runs on import), so nothing in it can be unit-tested. */

/** Turn a `--workspace` option into the command's `workspaceId` field.
 *
 *  Tests PRESENCE, not truthiness: CAC parses an empty option value into the
 *  NUMBER 0 — falsy but present — so a truthiness check drops the assertion
 *  and the command answers about the ACTIVE workspace instead of the named
 *  one. The 0 is normalized back to '' so the command layer's purpose-built
 *  rejection is what the user sees. (A literal `--workspace 0` is therefore
 *  unrepresentable; workspace ids are uuids.) */
export const workspaceAssertion = (workspace: unknown): {workspaceId?: string} => {
  if (workspace === undefined) return {}
  if (workspace === 0) return {workspaceId: ''}
  // Not `String(workspace)`: CAC hands back an ARRAY for a repeated flag, and
  // 'a,b' satisfies the wire schema's `z.string()` where the array itself was
  // cleanly rejected. Coercing turns a caller error into a confident answer
  // about a graph that does not exist — the failure this option prevents.
  if (typeof workspace !== 'string') {
    throw new Error(
      `--workspace expects a single workspace id; got ${JSON.stringify(workspace)}.`,
    )
  }
  return {workspaceId: workspace}
}

/** Turn a `--limit` option into the command's `limit` field.
 *
 *  Same CAC artifact as above with a different blast radius: `--limit
 *  "$UNSET"` arrives as the number 0, and every consumer downstream reads 0
 *  as a real bound — `typeof command.limit === 'number'` passes, and a
 *  `limit = 50` destructuring default is bypassed — so the query runs
 *  `LIMIT 0` and reports "nothing found" for a graph that has the answer. */
export const limitOption = (limit: unknown): {limit?: number} => {
  if (limit === undefined) return {}
  const parsed = Number(limit)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--limit expects a positive integer; got ${JSON.stringify(limit)}.`
      // The user typed `--limit ""` but the message can only show them the 0 CAC
      // handed us, so name the expansion or it reads as someone else's bug.
      + (parsed === 0 ? ' An empty value (a shell expanding an unset variable) arrives as 0.' : ''),
    )
  }
  return {limit: parsed}
}

/** Turn a `--scope` option into the command's `scope` field.
 *
 *  Same CAC artifact as `workspaceAssertion`, normalized the same way — without
 *  it `--scope ""` reaches the kernel as the string '0' and is refused naming a
 *  value nobody typed. The VALUE is not validated here: the kernel owns that
 *  refusal, so one spelling of it exists rather than two that can disagree. */
export const scopeAssertion = (scope: unknown): {scope?: string} => {
  if (scope === undefined) return {}
  if (scope === 0) return {scope: ''}
  if (typeof scope !== 'string') {
    throw new Error(`--scope expects a single value; got ${JSON.stringify(scope)}.`)
  }
  return {scope}
}
