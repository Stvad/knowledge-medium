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

/** cac numberifies every digits-only option value before this code sees it,
 *  so `00123` arrives as 123 and its text is gone: turning it back into a
 *  string would name something else (another id prefix, another type). */
export const refuseNumberified = (flag: string, value: unknown): void => {
  if (typeof value !== 'number') return
  throw new Error(
    `${flag} got the number ${value}: the CLI reads a digits-only value as a number, which drops leading zeros. `
    + `Send it as text with \`kmagent raw '<json>'\`; a block ref can also be written as ^ followed by the id exactly as printed.`,
  )
}

/** CAC hands back an array for a flag given more than once; joining it would
 *  send a value nobody typed, and picking one would drop the other. */
export const refuseRepeated = (flag: string, value: unknown): void => {
  if (!Array.isArray(value)) return
  throw new Error(`${flag} expects a single value; got ${JSON.stringify(value)}.`)
}

/** `append-markdown`'s --first / --after <id> / --before <id> as its
 *  `position` field; an anchor CAC numberified is refused, not re-stringified. */
export const appendPositionOption = (
  options: {first?: unknown, after?: unknown, before?: unknown},
): {position?: {kind: 'first'} | {kind: 'after' | 'before', siblingId: string}} => {
  for (const kind of ['first', 'after', 'before'] as const) refuseRepeated(`--${kind}`, options[kind])
  const given = [options.first === true, options.after !== undefined, options.before !== undefined]
  if (given.filter(Boolean).length > 1) {
    throw new Error('append-markdown takes at most one of --first, --after <id>, --before <id>')
  }
  if (options.first === true) return {position: {kind: 'first'}}
  for (const kind of ['after', 'before'] as const) {
    const value = options[kind]
    if (value === undefined) continue
    refuseNumberified(`--${kind}`, value)
    return {position: {kind, siblingId: String(value)}}
  }
  return {}
}

/** A repeatable option, or the text after `--`, as a string list. */
export const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return [value]
  return []
}

/** A verb's text operands as one list, in order: its positional texts, then
 *  the texts after `--` (where a text starting with `-` goes, since it would
 *  read as a flag). One list, so a text on one side of `--` is never dropped
 *  for one on the other. */
export const textArguments = (positionals: readonly unknown[], afterDashes: unknown): string[] =>
  [...positionals.flatMap(toStringArray), ...toStringArray(afterDashes)]

/** `append-markdown`'s markdown: its text operands joined, or undefined to
 *  read stdin — no text at all, or a lone `-` (`-- -` too, as for `cat`). */
export const markdownText = (markdown: unknown, afterDashes: unknown): string | undefined => {
  const texts = textArguments([markdown], afterDashes)
  return texts.length === 0 || (texts.length === 1 && texts[0] === '-') ? undefined : texts.join(' ')
}

/** `edit-block`'s <old> and <new>: positional, or after `--` when either
 *  starts with `-` (which would read as a flag). */
export const editArgumentsOption = (
  old: unknown,
  replacement: unknown,
  afterDashes: unknown,
): {old: string, new: string} => {
  // `milk -- -oat` is two texts; a pair on each side of `--` is four, refused.
  const texts = textArguments([old, replacement], afterDashes)
  if (texts.length !== 2) {
    throw new Error("edit-block takes exactly <old> and <new> — after `--` when either starts with '-'")
  }
  return {old: String(texts[0]), new: String(texts[1])}
}
