/** What a name field should commit for a definition or property key.
 *
 *  Blur fires on a bare focus-and-leave, so an UNEDITED draft must commit the
 *  committed value verbatim — trimming it there is a rename nobody asked for,
 *  and a property definition's name IS the cell key its values are stored
 *  under. A stored name can legitimately carry surrounding whitespace: a
 *  definition synthesized for an orphaned cell key mints that key verbatim on
 *  purpose (`keyCannotBeDefined` in `propertyDefinitionSynthesis.ts` explains
 *  why trimming at the mint is worse), and imports predate the hygiene rules.
 *
 *  Trim only what the user actually typed. */
export const trimIfEdited = (draft: string, committed: string): string =>
  draft === committed ? committed : draft.trim()
