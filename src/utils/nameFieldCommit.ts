/** What a name field should commit for a definition or property key.
 *
 *  Blur fires on a bare focus-and-leave, so an UNEDITED draft must commit the
 *  committed value verbatim — trimming it there is a rename nobody asked for.
 *  A stored name can legitimately carry surrounding whitespace: a row created
 *  before the name-hygiene rules, an import, or a synthesized orphan
 *  definition (which mints the definition-less cell key verbatim on purpose,
 *  because trimming at the mint would leave the padded key still orphaned).
 *  And a property definition's name IS the cell key its values are stored
 *  under, so renaming it re-keys — or orphans — live data.
 *
 *  Trim only what the user actually typed. */
export const trimIfEdited = (draft: string, committed: string): string =>
  draft === committed ? committed : draft.trim()
